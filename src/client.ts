/**
 * A small client for the Go core's delivery API (/api/v1): live content only,
 * one answer shape, absolute asset URLs. It runs at build time (loaders, the
 * integration) and at request time (on-demand pages, on Workers too: it only
 * needs fetch).
 *
 *   const cms = createClient({ url: "https://cms.example.com", token: "…" });
 *   const { data: page, included } = await cms.page("about");
 *
 * Every response's Cache-Tag header is collected in `cms.tags`, so a page
 * rendered on demand can say what it was built from (see the middleware), and
 * every X-CMS-Schema-Digest header in `cms.digests`, so a build can tell that
 * the CMS's schema moved under it.
 */
import type {
  CmsCollection, CmsContent, CmsEntry, CmsGlobal, CmsHealthCheck, CmsPage, CmsRedirect, CmsRobots, CmsSchema,
  CmsSchemaMeta, CmsSite, CmsSiteMeta, CmsSitemapUrl, ContentMeta, Envelope, ListMeta,
} from "./types.js";
import type { FormDefinition, FormList } from "./forms/types.js";

export type * from "./types.js";

/** The header every token-authed /api/v1 answer carries: the schema's digest. */
export const SCHEMA_DIGEST_HEADER = "X-CMS-Schema-Digest";

export interface ClientOptions {
  /** The CMS's address, e.g. https://cms.example.com */
  url: string;
  /** A service token on the site's role (Settings › Service tokens). */
  token: string;
  fetch?: typeof fetch;
  /** Where to collect the answers' cache tags; a new set by default. */
  tags?: Set<string>;
  /** Where to collect the schema digests the answers carried; a new set by default. */
  digests?: Set<string>;
}

export class CmsError extends Error {
  constructor(message: string, readonly status: number, readonly path: string, readonly body?: unknown) {
    super(message);
    this.name = "CmsError";
  }
}

export type CmsClient = ReturnType<typeof createClient>;

export function createClient({ url, token, fetch: fetcher, tags = new Set<string>(), digests = new Set<string>() }: ClientOptions) {
  const base = url.replace(/\/+$/, "");
  // Looked up per call, so a fetch a test or a platform installs later is used.
  const send: typeof fetch = (...args) => (fetcher ?? globalThis.fetch)(...args);

  async function request(path: string, accept = "application/json", init: RequestInit = {}): Promise<Response> {
    const response = await send(`${base}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, Accept: accept, ...init.headers },
    });
    response.headers.get("Cache-Tag")?.split(",").forEach((tag) => tag.trim() && tags.add(tag.trim()));
    const digest = response.headers.get(SCHEMA_DIGEST_HEADER);
    if (digest) digests.add(digest);
    if (!response.ok) {
      let body: unknown;
      try { body = await response.json(); } catch { body = undefined; }
      const { capability, message } = (body ?? {}) as { capability?: string; message?: string };
      const reason = response.status === 401 ? "the token was refused"
        : response.status === 403 ? `the token's role doesn't grant ${capability ?? "it"} (Settings › Roles)`
        : response.status === 404 ? `not found${message ? ` (${message})` : ""}`
        : `HTTP ${response.status}${message ? `: ${message}` : ""}`;
      throw new CmsError(`CMS ${path}: ${reason}`, response.status, path, body);
    }
    return response;
  }

  async function get<T, M = Record<string, unknown>>(path: string): Promise<Envelope<T, M>> {
    return (await request(`/api/v1${path}`)).json() as Promise<Envelope<T, M>>;
  }

  /** Every page of a list, followed to the end. */
  async function all<T>(path: string): Promise<{ data: T[]; included: NonNullable<Envelope<T>["included"]> }> {
    const data: T[] = [];
    const assets: Record<string, any> = {};
    let page: number | null = 1;
    while (page) {
      const separator = path.includes("?") ? "&" : "?";
      const answer: Envelope<T[], ListMeta> = await get<T[], ListMeta>(`${path}${separator}per=100&page=${page}`);
      data.push(...answer.data);
      Object.assign(assets, answer.included?.assets ?? {});
      page = answer.meta.next_page;
    }
    return { data, included: { assets } };
  }

  const query = (params: Record<string, string | undefined>) => {
    const search = new URLSearchParams(Object.entries(params).filter(([, v]) => v) as [string, string][]).toString();
    return search ? `?${search}` : "";
  };

  return {
    /** The tags of every answer so far (Cache-Tag), for purging what a page used. */
    tags,
    /** The schema digests the answers carried (X-CMS-Schema-Digest). */
    digests,
    site: () => get<CmsSite, CmsSiteMeta>("/site"),
    /** Every live page, entry and global; with `since` (a previous meta.cursor), only what changed. */
    content: (since?: string) => get<CmsContent, ContentMeta>(`/content${query({ since })}`),
    schema: () => get<CmsSchema, CmsSchemaMeta>("/schema"),
    pages: (options: { locale?: string } = {}) => all<CmsPage>(`/pages${query(options)}`),
    /** A page by its path ("home", "about/team"); each segment is URL-encoded. */
    page: (path: string) => get<CmsPage>(`/pages/${segments(path)}`),
    collections: () => get<CmsCollection[]>("/collections"),
    entries: (collection: string, options: { locale?: string } = {}) =>
      all<CmsEntry>(`/collections/${encodeURIComponent(collection)}/entries${query(options)}`),
    entry: (collection: string, slug: string) =>
      get<CmsEntry>(`/collections/${encodeURIComponent(collection)}/entries/${encodeURIComponent(slug)}`),
    globals: () => get<CmsGlobal[]>("/globals"),
    global: (slug: string) => get<CmsGlobal>(`/globals/${encodeURIComponent(slug)}`),
    sitemap: () => get<CmsSitemapUrl[], { total: number }>("/sitemap"),
    redirects: () => get<CmsRedirect[]>("/redirects"),
    /** The site's robots.txt, as written in the CMS or made from Settings › Search. */
    robots: () => get<CmsRobots>("/robots"),
    /** The redirects as a Cloudflare _redirects file. */
    redirectsFile: async () => (await request("/api/v1/redirects.txt", "text/plain")).text(),
    siteHealth: () => get<CmsHealthCheck[]>("/site_health"),
    /** The Forms plugin: a form's live definition (GET /api/x/forms/definition). */
    formDefinition: async (slug: string): Promise<FormDefinition> =>
      ((await (await request(`/api/x/forms/definition?form=${encodeURIComponent(slug)}`)).json()) as { form: FormDefinition }).form,
    /** The Forms plugin: every form, with its digest (GET /api/x/forms/list). */
    formList: async (): Promise<FormList> => (await request("/api/x/forms/list")).json() as Promise<FormList>,
    /** Tell the CMS a build ran (POST /api/frontend/builds). */
    reportBuild: async (report: BuildReport): Promise<{ ok: boolean; approval_pending: boolean }> =>
      (await request("/api/frontend/builds", "application/json", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(report),
      })).json() as Promise<{ ok: boolean; approval_pending: boolean }>,
    /** Any other /api/v1 path. */
    get,
  };
}

/** What a build tells the CMS. The Go core keeps render, webhook_url and content_cursor; the rest is for its log. */
export interface BuildReport {
  render: "static" | "server" | "hybrid";
  webhook_url?: string;
  content_cursor?: string;
  integration?: string;
  integration_version?: string;
  framework?: string;
  framework_version?: string;
  pages?: number;
  site_url?: string;
  duration_ms?: number;
  schema_digest?: string;
  /** Where the live site answers the launch checklist's questions (POST, signed): /_cms/checks. */
  checks_url?: string;
  /** The build's items for the CMS's launch checklist (src/launch-checks.ts). */
  checks?: import("./launch-checks.js").LaunchCheck[];
}

function segments(path: string): string {
  return path.replace(/^\/+|\/+$/g, "").split("/").map(encodeURIComponent).join("/");
}

/**
 * The path a page or entry is served at on this site, from its `url`. The CMS
 * gives a record's `url` site-relative ("/", "/about", "/fr/a-propos",
 * "/posts/hello") — unless an editor set an SEO canonical, which can be
 * absolute. An absolute URL on the site's own host routes by its path; one
 * elsewhere (a canonical pointing at another site) falls back to where the
 * record lives by default: "/<path>" for a page ("home" is "/"), "/<collection>/<slug>"
 * for an entry, under its locale's prefix unless it's the default locale.
 *
 *   // in getStaticPaths, where Astro.site isn't available:
 *   params: { path: routeParam(page, { site: import.meta.env.SITE }) }
 */
export function recordPath(
  record: Pick<CmsPage, "url" | "locale"> & { path?: string; slug?: string; collection?: string },
  options: { site?: string | URL; defaultLocale?: string } = {},
): string {
  const url = record.url ?? "";
  if (!/^https?:\/\//i.test(url)) return normalize(url || fallback());

  const absolute = new URL(url);
  const site = options.site ? new URL(String(options.site)) : null;
  if (!site || absolute.host === site.host) return normalize(absolute.pathname);
  return fallback();

  function fallback(): string {
    const own = record.collection ? `/${record.collection}/${record.slug ?? ""}` : `/${(record.path ?? "").replace(/^\/+|\/+$/g, "")}`;
    const path = own === "/home" ? "/" : own;
    const prefix = options.defaultLocale && record.locale && record.locale !== options.defaultLocale ? `/${record.locale}` : "";
    return normalize(prefix && path === "/" ? prefix : `${prefix}${path}`);
  }
}

/** recordPath as a `[...path]` route parameter: no leading slash, the home page `undefined`. */
export function routeParam(...args: Parameters<typeof recordPath>): string | undefined {
  return recordPath(...args).replace(/^\/+/, "") || undefined;
}

function normalize(path: string): string {
  const clean = `/${path.replace(/^\/+/, "")}`;
  return clean.length > 1 ? clean.replace(/\/+$/, "") : clean;
}

/**
 * Where a CMS link field points, as an href: a URL as it is, a page by its
 * path ("home" is "/"), an entry under its collection. Pass the site's
 * locale for a page or entry in a language other than the default.
 *
 *   <a href={linkHref(item.link)}>{item.label}</a>
 */
export function linkHref(
  link: { kind: string; value: string; collection?: string } | null | undefined,
  options: { locale?: string; defaultLocale?: string } = {},
): string | undefined {
  if (!link?.value) return undefined;
  if (link.kind === "url") return link.value;
  const prefix = options.locale && options.locale !== (options.defaultLocale ?? options.locale) ? `/${options.locale}` : "";
  if (link.kind === "page") {
    const path = link.value.replace(/^\/+|\/+$/g, "");
    return path === "home" || path === "" ? prefix || "/" : `${prefix}/${path}`;
  }
  if (link.kind === "entry") return `${prefix}/${link.collection}/${link.value.replace(/^\/+/, "")}`;
  return undefined;
}
