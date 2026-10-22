/**
 * What a build checks about the site it built, for the CMS's launch
 * checklist (Tools › Launch; librepublishgo's docs/launch-checklist.md):
 * reported with the build (POST /api/frontend/builds, `checks`) and shown
 * there beside the CMS's own items, each with its evidence. A build only
 * reports: a failing item warns in the build's log and never stops it.
 *
 * The integration's items are `build.*`; the ones a site declares
 * (`cms({ checks })`) are `site.*`.
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { textFiles } from "./local-files.js";
import type { FormList } from "./forms/types.js";

export type LaunchState = "passes" | "fails" | "warns" | "unknown" | "n_a";

/** One checklist item, as the build report carries it. */
export interface LaunchCheck {
  key: string;
  group: string;
  title: string;
  state?: LaunchState;
  evidence?: string;
  /** A site shouldn't go live with it failing. */
  launch?: boolean;
  /** A person ticks it in the CMS (state is theirs to give). */
  manual?: boolean;
  /** Where it's put right: an admin address ("#/settings/email") or an https URL. */
  fix?: string;
  fix_label?: string;
}

/** A check the site declares: one the build runs, or one a person ticks. */
export interface SiteCheck {
  /** Unique within the site: "stella" becomes "site.stella". Lowercase letters, digits, _ . - */
  key: string;
  /** What should hold: "Stella receives landing leads". */
  title: string;
  /** A site shouldn't go live without it. */
  launch?: boolean;
  /**
   * Runs at the end of the build: true (passes), false (fails), or a state
   * and the evidence. A throw is reported as unknown, with its message.
   * Leave it out for an item a person ticks in the CMS.
   */
  run?: () => boolean | { state: LaunchState; evidence: string } | Promise<boolean | { state: LaunchState; evidence: string }>;
  /** Where it's put right, an https URL (a dashboard) or an admin address. */
  fix?: string;
  fixLabel?: string;
}

/** The variables a site needs: where it's built, and where it runs. */
export interface SiteEnv {
  /** Read while building (the build's environment or .env). */
  build?: string[];
  /** Read by the site's on-demand routes (the host's variables and secrets): a person confirms them. */
  runtime?: string[];
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const list = (items: string[], n = 6) => items.slice(0, n).join(", ") + (items.length > n ? `, … (${items.length})` : "");

/** build.schema_lock: the build ran on the schema cms.lock.json pins (it stops otherwise). */
export function schemaCheck(digest: string | undefined): LaunchCheck {
  return {
    key: "build.schema_lock", group: "build", title: "The site was built against the CMS's current schema", launch: true,
    state: digest ? "passes" : "unknown",
    evidence: digest ? `cms.lock.json matched the CMS (${digest.slice(0, 19)}…)` : "No schema digest: the build didn't read the CMS's schema.",
  };
}

/**
 * build.prerendered: every route is prerendered but the ones the site says
 * render on demand (`cms({ onDemand })`) and the integration's own.
 */
export function prerenderCheck(onDemand: string[], declared: string[] | undefined): LaunchCheck {
  const check: LaunchCheck = { key: "build.prerendered", group: "build", title: "Only the routes meant to run on demand do", launch: true };
  if (!onDemand.length) return { ...check, state: "passes", evidence: "Every route is prerendered: the site is static." };
  if (!declared) {
    return { ...check, state: "warns", evidence: `Rendered on demand: ${list(onDemand)}. Name them in cms({ onDemand }) so the build can tell a page that lost its prerender from one meant to run per request.` };
  }
  const extra = onDemand.filter((route) => !declared.includes(route));
  return extra.length
    ? { ...check, state: "fails", evidence: `Rendered on demand but not in cms({ onDemand }): ${list(extra)}. A page that should be static lost its prerender, or the list needs it.` }
    : { ...check, state: "passes", evidence: `Prerendered but for ${list(onDemand)}, as declared.` };
}

/**
 * build.no_secrets: the CMS's token is in no built file, and its address in
 * none of the server's (a prerendered site reads the CMS only while it builds).
 */
export async function secretsCheck(options: { dirs: URL[]; serverDir?: URL; token: string; cmsUrl: string; onDemand: boolean }): Promise<LaunchCheck> {
  const check: LaunchCheck = { key: "build.no_secrets", group: "build", title: "The CMS's token isn't in the built site", launch: true };
  const withToken: string[] = [];
  const withAddress: string[] = [];
  let read = 0;
  const server = options.serverDir ? fileURLToPath(options.serverDir) : null;
  for (const dir of options.dirs) {
    for await (const file of textFiles(fileURLToPath(dir))) {
      read++;
      const text = await readFile(file, "utf8");
      if (options.token && text.includes(options.token)) withToken.push(file);
      // A site with on-demand routes reads the CMS at runtime: its address there is expected.
      if (!options.onDemand && server && file.startsWith(server) && options.cmsUrl && text.includes(options.cmsUrl)) withAddress.push(file);
    }
  }
  if (withToken.length) return { ...check, state: "fails", evidence: `The CMS token is in ${list(withToken)}. Anyone who reads those files can read the CMS as the site.` };
  if (withAddress.length) return { ...check, state: "warns", evidence: `The CMS's address is in the server's code (${list(withAddress)}), though every page is prerendered.` };
  return { ...check, state: "passes", evidence: `${plural(read, "built file")} read: no token${options.onDemand ? "" : ", and no CMS address in the server's code"}.` };
}

/** build.media_local: no page links a file on the CMS (localFiles copied them all). */
export function mediaCheck(result: { copied: number; left: string[]; missing: string[] } | null, onDemandPages: boolean): LaunchCheck {
  const check: LaunchCheck = { key: "build.media_local", group: "build", title: "The site serves its own images", launch: true };
  if (!result) return { ...check, state: "warns", evidence: "cms({ localFiles: false }): pages link files on the CMS, so the live site depends on the CMS's host for every image." };
  if (result.left.length) {
    return { ...check, state: "fails", evidence: `${list(result.left)} still link files on the CMS${result.missing.length ? ` (the CMS has no file for ${list(result.missing, 4)})` : ""}.` };
  }
  const onDemand = onDemandPages ? " Pages rendered on demand still link the CMS." : "";
  return { ...check, state: "passes", evidence: `${plural(result.copied, "file")} from the CMS copied into the build; no built page links the CMS.${onDemand}` };
}

/** build.site_files: a sitemap, robots.txt and a 404 page. */
export function siteFilesCheck(dir: URL, sitemap: boolean): LaunchCheck {
  const missing = ["sitemap.xml", "robots.txt", "404.html"].filter((file) => !existsSync(fileURLToPath(new URL(file, dir))));
  const check: LaunchCheck = { key: "build.site_files", group: "build", title: "The site has a sitemap, robots.txt and a 404 page" };
  if (!missing.length) return { ...check, state: "passes", evidence: "sitemap.xml, robots.txt and 404.html were built." };
  const hint = missing.includes("sitemap.xml") && !sitemap ? " (cms({ sitemap: false }): the site makes its own)" : "";
  return { ...check, state: "fails", evidence: `Not built: ${missing.join(", ")}${hint}.` };
}

/** build.redirects: _redirects came from the CMS (a site's own stop the build). */
export function redirectsCheck(rules: number): LaunchCheck {
  return { key: "build.redirects", group: "build", title: "Redirects come from the CMS", state: "passes",
    evidence: `_redirects holds the CMS's ${plural(rules, "rule")} and nothing else.`, fix: "#/redirects", fix_label: "Redirects" };
}

/**
 * build.forms: the forms the built pages use exist in the CMS and take
 * submissions. A form is "used" when the client code names its slug;
 * a <StaticForm>'s slug is read from its props, so one the CMS doesn't have
 * is caught too.
 */
export async function formsCheck(dir: URL, forms: FormList["forms"] | null): Promise<LaunchCheck> {
  const check: LaunchCheck = { key: "build.forms", group: "build", title: "The forms the site draws exist in the CMS", launch: true, fix: "#/plugins/forms/forms", fix_label: "Forms" };
  if (!forms) return { ...check, state: "unknown", evidence: "Couldn't read the CMS's forms." };
  const quoted = new Set<string>();
  const props = new Set<string>();
  for await (const file of textFiles(fileURLToPath(dir))) {
    const text = await readFile(file, "utf8");
    for (const m of text.matchAll(/&quot;slug&quot;:\[0,&quot;([a-z0-9_-]+)&quot;\]/g)) props.add(m[1]);
    // As a string in any of the forms a build writes it: "x", 'x', `x` (a
    // minifier's template literal), or &quot;x&quot; in an island's props.
    for (const form of forms) {
      if (['"', "'", "`"].some((q) => text.includes(`${q}${form.slug}${q}`)) || text.includes(`&quot;${form.slug}&quot;`)) quoted.add(form.slug);
    }
  }
  const bySlug = new Map(forms.map((form) => [form.slug, form]));
  const unknown = [...props].filter((slug) => !bySlug.has(slug));
  const used = [...new Set([...quoted, ...props])].filter((slug) => bySlug.has(slug));
  const closed = used.filter((slug) => !bySlug.get(slug)!.open);
  if (unknown.length) return { ...check, state: "fails", evidence: `Pages draw forms the CMS doesn't have: ${unknown.join(", ")}.` };
  if (closed.length) return { ...check, state: "fails", evidence: `Pages draw forms that aren't taking submissions: ${closed.join(", ")}.` };
  if (!used.length) return { ...check, state: "n_a", evidence: "No page draws a CMS form." };
  return { ...check, state: "passes", evidence: `Drawn: ${used.join(", ")}, each open in the CMS.` };
}

/**
 * build.env: the variables the site says its build needs were set (names
 * only: never a value). The runtime ones become a manual item.
 */
export function envChecks(env: SiteEnv | undefined, has: (name: string) => boolean): LaunchCheck[] {
  if (!env) return [];
  const out: LaunchCheck[] = [];
  if (env.build?.length) {
    const unset = env.build.filter((name) => !has(name));
    out.push({
      key: "build.env", group: "build", title: "The build had the variables the site needs", launch: true,
      state: unset.length ? "fails" : "passes",
      evidence: unset.length ? `Not set where the site was built: ${unset.join(", ")}.` : `Set: ${env.build.join(", ")}.`,
    });
  }
  if (env.runtime?.length) {
    out.push({
      key: "build.runtime_env", group: "build", manual: true, launch: true,
      title: `Set on the host: ${env.runtime.join(", ")}`,
      evidence: "The site's on-demand routes read these from the host (its variables and secrets), which the build can't see: tick it once they're set where the site runs.",
    });
  }
  return out;
}

const SITE_KEY = /^[a-z0-9_.-]{1,60}$/;

/** The site's own items: each run (a throw is unknown), or left for a person to tick. */
export async function siteChecks(checks: SiteCheck[] | undefined): Promise<LaunchCheck[]> {
  const out: LaunchCheck[] = [];
  for (const check of checks ?? []) {
    if (!SITE_KEY.test(check.key)) throw new Error(`cms({ checks }): "${check.key}" isn't a key (lowercase letters, digits, _ . -, at most 60).`);
    const item: LaunchCheck = { key: `site.${check.key}`, group: "site", title: check.title, launch: check.launch, fix: check.fix, fix_label: check.fixLabel };
    if (!check.run) {
      out.push({ ...item, manual: true });
      continue;
    }
    try {
      const answer = await check.run();
      if (typeof answer === "boolean") out.push({ ...item, state: answer ? "passes" : "fails", evidence: answer ? "The site's check passed." : "The site's check failed." });
      else out.push({ ...item, state: answer.state, evidence: answer.evidence });
    } catch (error) {
      out.push({ ...item, state: "unknown", evidence: `The check threw: ${(error as Error).message}` });
    }
  }
  return out;
}
