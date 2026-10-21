/**
 * @librepublish/astro — an Astro site on LibrePublish CMS (the Go core).
 *
 *   // astro.config.mjs
 *   import { defineConfig } from "astro/config";
 *   import cloudflare from "@astrojs/cloudflare";
 *   import cms from "@librepublish/astro";
 *
 *   export default defineConfig({ adapter: cloudflare(), integrations: [cms()] });
 *
 * With CMS_BASE_URL and CMS_API_TOKEN set (environment or .env), it:
 *
 *   - reads the CMS's schema and holds it to cms.lock.json: `astro build`,
 *     `astro sync` and `astro check` stop when it moved (run `npx
 *     librepublish-astro sync`); `astro dev` takes the new one and says so;
 *   - generates TypeScript from it ("librepublish:types": every block type's
 *     data, BlockComponents, Page, Entries, Globals) — a failure stops a build;
 *   - gives the content loaders the same schema as Zod, so a record outside it
 *     fails the build;
 *   - configures the site from the CMS: its URL (`site`), locales (Astro i18n),
 *     the CMS's files as remote images at the CMS's widths, and the env schema;
 *   - adds /sitemap.xml and /robots.txt, and, when pages render on demand,
 *     /_cms/webhook (signed purges) and a middleware that tags each response
 *     with the content it used (Cache-Tag);
 *
 * and after `astro build`:
 *
 *   - stops if any answer during the build carried another schema digest;
 *   - writes the CMS's redirects as Cloudflare's _redirects — the only place a
 *     site's redirects come from (a site defining its own stops the build);
 *   - checks the site against Site health and its own basics;
 *   - tells the CMS the build ran and how the site renders (static, server or
 *     hybrid), so publishing rebuilds a static site, purges one that renders
 *     on demand, and does both for a hybrid one.
 *
 * Forms (the Forms plugin) render on demand from their live definition:
 * <Form slug="…"/> (@librepublish/astro/components/Form.astro); on a static
 * page, in the browser: <StaticForm slug="…"/> (a Svelte island).
 */
import { access, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AstroIntegration } from "astro";
import { envField } from "astro/config";
import { healthFindings, siteFindings, type Finding, REDIRECTS_LIVE_IN_THE_CMS, redirectRules } from "./build-checks.js";
import type { CmsClient } from "./client.js";
import { buildClient, buildState, keepConnection, keepSchema, resolveConnection, type Connection } from "./connection.js";
import { lastCursor } from "./loaders.js";
import { accepted, decide, LOCK_FILE, lockFrom, readLock, writeLock, type Command } from "./lock.js";
import { readLive, type LiveRead } from "./schema/live.js";
import { moduleTypes } from "./schema/typegen.js";
import { servedSitemap } from "./sitemap-filter.js";
import type { CmsSite, CmsSiteMeta } from "./types.js";

export const NAME = "librepublish";
/** This package's version, as package.json has it (reported with each build). */
export const VERSION: string = createRequire(import.meta.url)("../package.json").version;

export interface CmsOptions {
  /** The CMS's address. Default: CMS_BASE_URL. */
  url?: string;
  /** The site's service token. Default: CMS_API_TOKEN. Keep it out of source. */
  token?: string;
  /** Configure Astro's i18n from the CMS's locales. Default: true. */
  i18n?: boolean;
  /** Add /sitemap.xml and /robots.txt. Default: true. */
  sitemap?: boolean;
  /** What failing Site health checks do to a build. Default: "warn". */
  siteHealth?: "warn" | "error" | "off";
  /** Report each build to the CMS. Default: true. */
  report?: boolean;
}

export default function cms(options: CmsOptions = {}): AstroIntegration {
  const { i18n = true, sitemap = true, siteHealth = "warn", report = true } = options;
  if ("redirects" in options) {
    throw new Error(`cms({ redirects }) is gone: the CMS's redirects are always written. ${REDIRECTS_LIVE_IN_THE_CMS}.`);
  }
  let connection: Connection | null = null;
  let client: CmsClient | null = null;
  let site: { data: CmsSite; meta: CmsSiteMeta } | null = null;
  let read: LiveRead | null = null;
  let command: Command = "dev";
  let siteUrl: string | undefined;
  let clientDir: URL | undefined;
  let onDemand = false;
  let render: "static" | "server" | "hybrid" = "static";
  let onDemandPatterns: RegExp[] = [];
  let startedAt = 0;
  let trailingSlash: string | undefined;

  // build, sync and check must hold to the lock; dev and preview get on with a warning.
  const strict = () => command === "build" || command === "sync";

  return {
    name: NAME,
    hooks: {
      "astro:config:setup": async ({ config, command: given, updateConfig, injectRoute, addMiddleware, addWatchFile, logger }) => {
        startedAt = Date.now();
        command = given;
        trailingSlash = config.trailingSlash;
        const own = Object.keys(config.redirects ?? {});
        if (own.length) {
          throw new Error(`${REDIRECTS_LIVE_IN_THE_CMS}: astro.config's \`redirects\` defines ${own.length} (${own.slice(0, 3).join(", ")}${own.length > 3 ? ", …" : ""}).`);
        }
        const root = fileURLToPath(config.root);
        connection = resolveConnection(root, command === "dev" ? "development" : "production", options);

        updateConfig({
          env: {
            schema: {
              CMS_BASE_URL: envField.string({ context: "server", access: "secret", optional: true }),
              CMS_API_TOKEN: envField.string({ context: "server", access: "secret", optional: true }),
              CMS_WEBHOOK_SECRET: envField.string({ context: "server", access: "secret", optional: true }),
              CMS_FORM_HOOK_SECRET: envField.string({ context: "server", access: "secret", optional: true }),
              CLOUDFLARE_ZONE_ID: envField.string({ context: "server", access: "secret", optional: true }),
              CLOUDFLARE_API_TOKEN: envField.string({ context: "server", access: "secret", optional: true }),
            },
          },
        });
        // A preview serves what a build made; the server reads its own variables.
        if (command === "preview") return;

        if (!connection) {
          const message = "CMS_BASE_URL and CMS_API_TOKEN aren't set (environment or .env), so the site can't read the CMS.";
          if (strict()) throw new Error(message);
          logger.warn(message);
          return;
        }
        keepConnection(connection);
        client = buildClient();

        try {
          site = await client.site();
          read = await readLive(client, site, connection.url);
        } catch (error) {
          if (strict()) throw error;
          logger.warn(`Couldn't read the CMS at ${connection.url}: ${(error as Error).message}`);
        }

        if (read) {
          const decision = decide(await readLock(root), read.live, { command, accept: accepted() });
          if (decision.action === "fail") throw new Error(decision.message);
          if (decision.action === "write") {
            await writeLock(root, lockFrom(read.live));
            logger[decision.level](decision.message);
          }
          keepSchema(Promise.resolve({ schema: read.schema, digest: read.live.digest }));
          // `librepublish-astro sync` rewrites it: dev restarts on the new schema.
          addWatchFile(join(root, LOCK_FILE));
        }

        // Asset URLs start with the CMS's own address (APP_URL), which can
        // differ from the one the build reaches the API at.
        const hosts = [new URL(connection.url)];
        if (site?.meta.cms_url && new URL(site.meta.cms_url).host !== hosts[0].host) hosts.push(new URL(site.meta.cms_url));
        siteUrl = config.site ?? (site?.data.url || undefined);
        const locales = site?.data.locales ?? [];
        const widths = site?.data.image_widths;
        updateConfig({
          site: siteUrl,
          image: {
            remotePatterns: hosts.map((host) => ({
              protocol: host.protocol.replace(":", ""),
              hostname: host.hostname,
              ...(host.port ? { port: host.port } : {}),
              pathname: "/files/**",
            })),
            ...(widths?.length && !config.image.breakpoints ? { breakpoints: widths } : {}),
          },
          ...(i18n && !config.i18n && site && locales.length > 1
            ? { i18n: { locales, defaultLocale: site.data.default_locale, routing: { prefixDefaultLocale: false, redirectToDefaultLocale: false, fallbackType: "redirect" as const } } }
            : {}),
          // The digest the site is built against, for the runtime to compare with what the CMS says.
          // And the site's trailingSlash, for the sitemap's URLs to match its canonicals.
          vite: { define: {
            __LIBREPUBLISH_SCHEMA_DIGEST__: JSON.stringify(read?.live.digest ?? null),
            __LIBREPUBLISH_TRAILING_SLASH__: JSON.stringify(config.trailingSlash ?? "ignore"),
            // Where browsers reach the CMS, for <StaticForm>: its own address, else the build's.
            __LIBREPUBLISH_FORMS_URL__: JSON.stringify((site?.meta.cms_url || connection.url).replace(/\/+$/, "")),
          } },
        });

        if (sitemap) {
          injectRoute({ pattern: "/sitemap.xml", entrypoint: "@librepublish/astro/runtime/sitemap", prerender: true });
          if (!(await exists(new URL("robots.txt", config.publicDir)))) {
            injectRoute({ pattern: "/robots.txt", entrypoint: "@librepublish/astro/runtime/robots", prerender: true });
          }
        }

        // Pages can render on demand only with an adapter.
        onDemand = Boolean(config.adapter);
        if (onDemand) {
          injectRoute({ pattern: "/_cms/webhook", entrypoint: "@librepublish/astro/runtime/webhook", prerender: false });
          addMiddleware({ entrypoint: "@librepublish/astro/runtime/middleware", order: "pre" });
        }
      },

      "astro:config:done": async ({ config, injectTypes, logger }) => {
        clientDir = config.build.client;
        if (!read) return;
        try {
          injectTypes({ filename: "cms.d.ts", content: moduleTypes(read.schema, read.live.digest) });
        } catch (error) {
          const message = `Couldn't generate types from the CMS's schema: ${(error as Error).message}`;
          if (strict()) throw new Error(message);
          logger.warn(message);
        }
      },

      "astro:routes:resolved": ({ routes }) => {
        const own = (route: { entrypoint: string }) => route.entrypoint.includes("@librepublish/astro");
        const pages = routes.filter((route) => !own(route) && route.origin !== "internal");
        const prerendered = pages.filter((route) => route.isPrerendered).length;
        render = prerendered === pages.length ? "static" : prerendered === 0 ? "server" : "hybrid";
        onDemandPatterns = pages.filter((route) => !route.isPrerendered && route.type === "page").map((route) => route.patternRegex);
      },

      "astro:build:done": async ({ dir, pages, logger }) => {
        if (!client || !connection) return;

        // Every answer the build read must have come from the locked schema.
        const locked = read?.live.digest;
        const moved = [...buildState().digests].filter((digest) => digest !== locked);
        if (locked && moved.length) {
          throw new Error(`The CMS's schema changed during the build (${moved.join(", ")}, not ${locked}). Build again; if it changed for good, run \`npx librepublish-astro sync\` first.`);
        }

        // With an adapter the static files (and _redirects) go to the client directory.
        const assetsDir = onDemand && clientDir ? clientDir : dir;

        // _redirects is the CMS's alone. Rules already in it came from the
        // site (public/_redirects, or an adapter writing Astro's `redirects`).
        {
          const file = new URL("_redirects", assetsDir);
          const marker = "# From the CMS (Tools › Redirects)";
          const own = redirectRules((await readFile(file, "utf8").catch(() => "")).split(marker)[0]);
          if (own.length) {
            throw new Error(`${REDIRECTS_LIVE_IN_THE_CMS}: public/_redirects defines ${own.length} (${own.slice(0, 2).join("; ")}${own.length > 2 ? "; …" : ""}).`);
          }
          const rules = await client.redirectsFile();
          await writeFile(file, `${marker}\n${rules}`);
          logger.info(`_redirects: ${redirectRules(rules).length} rules from the CMS`);
        }

        if (sitemap) {
          const file = new URL("sitemap.xml", assetsDir);
          const xml = await readFile(file, "utf8").catch(() => null);
          if (xml) {
            const served = servedSitemap(xml, pages.map((page) => page.pathname), onDemandPatterns);
            if (served.removed.length) {
              await writeFile(file, served.xml);
              const examples = served.removed.slice(0, 3).join(", ");
              logger.warn(`sitemap.xml: left out ${served.removed.length} URL${served.removed.length === 1 ? "" : "s"} the CMS lists but this site has no page for (${examples}${served.removed.length > 3 ? ", …" : ""}). Give them a route, or mark them noindex in the CMS.`);
            }
          }
        }

        if (siteHealth !== "off") {
          const findings: Finding[] = [...(await siteFindings(assetsDir))];
          try {
            findings.push(...healthFindings((await client.siteHealth()).data));
          } catch (error) {
            logger.warn(`Couldn't read Site health: ${(error as Error).message}`);
          }
          for (const finding of findings) logger.warn(`Site health: ${finding.title} — ${finding.detail}`);
          if (findings.length && siteHealth === "error") {
            throw new Error(`${findings.length} Site health check${findings.length === 1 ? "" : "s"} failed (siteHealth: "error").`);
          }
          if (!findings.length) logger.info("Site health: everything checks out");
        }

        if (report) {
          try {
            const answer = await client.reportBuild({
              render,
              webhook_url: onDemand && siteUrl ? new URL(webhookPath(trailingSlash), siteUrl).href : undefined,
              content_cursor: lastCursor,
              integration: NAME,
              integration_version: VERSION,
              framework: "astro",
              framework_version: astroVersion(),
              pages: pages.length,
              site_url: siteUrl,
              duration_ms: Date.now() - startedAt,
              schema_digest: locked,
            });
            logger.info(`Reported the build to the CMS (${render}).`);
            if (answer.approval_pending) logger.warn("The CMS holds this site's change of rendering (or webhook) for approval: Settings › Deploy.");
          } catch (error) {
            logger.warn(`Couldn't report the build to the CMS: ${(error as Error).message}`);
          }
        }
      },
    },
  };
}

export { cms };

/**
 * Where /_cms/webhook answers, in the site's `trailingSlash` form: with
 * "always", Astro matches only "/_cms/webhook/", so that's the address the
 * build reports to the CMS.
 */
export function webhookPath(trailingSlash?: string): string {
  return trailingSlash === "always" ? "/_cms/webhook/" : "/_cms/webhook";
}
export type { CmsClient } from "./client.js";

async function exists(url: URL) {
  return access(url).then(() => true, () => false);
}

function astroVersion(): string | undefined {
  try {
    return (createRequire(import.meta.url)("astro/package.json") as { version: string }).version;
  } catch {
    return undefined;
  }
}
