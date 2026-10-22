/**
 * The built site's files from the CMS, served by the site itself.
 *
 * Content points at the CMS's media library by URL (`<CMS>/files/<key>/<name>`:
 * an image field resolves to it, an SEO image is absolute too). A deployed site
 * mustn't depend on the CMS host, so after the build every such file a built
 * page or file links to is copied into the build (`<client>/cms-files/<key>/<name>`)
 * and the link rewritten to the copy: absolute (the site's URL) in meta tags,
 * which need it, relative everywhere else. Only the files the site uses are
 * copied. Pages rendered on demand aren't touched: they still link the CMS.
 *
 * The forms' address (the CMS itself, which the browser calls to read and
 * post a form) is left alone: what mustn't be left is a file of the CMS's.
 */
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const LOCAL_PREFIX = "/cms-files/";

export interface LocalFilesResult {
  /** Files copied into the build. */
  copied: number;
  /** Built files whose links were rewritten. */
  rewritten: number;
  /** Built files that still link a CMS file (a copy that failed). */
  left: string[];
  /** Files the CMS couldn't give (a media record whose file is gone). */
  missing: string[];
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Every text file under dir a page or its assets can link from. */
export async function* textFiles(dir: string): AsyncGenerator<string> {
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* textFiles(path);
    else if (/\.(html|xml|txt|json|js|mjs|css)$/.test(entry.name)) yield path;
  }
}

/**
 * Copies the CMS files the built site links into `<clientDir>/cms-files/` and
 * points the links at the copies. `hosts` are the CMS's addresses its file
 * URLs can start with (CMS_BASE_URL, and its own public address); `fetchBase`
 * is where the build reaches it.
 */
export async function localizeFiles(options: {
  clientDir: URL;
  hosts: string[];
  fetchBase: string;
  siteUrl?: string;
  fetch?: typeof fetch;
}): Promise<LocalFilesResult> {
  const out = fileURLToPath(options.clientDir);
  const hosts = [...new Set(options.hosts.map((h) => h.replace(/\/+$/, "")).filter(Boolean))];
  const result: LocalFilesResult = { copied: 0, rewritten: 0, left: [], missing: [] };
  if (!hosts.length) return result;
  const get = options.fetch ?? fetch;
  const siteUrl = (options.siteUrl ?? "").replace(/\/+$/, "");
  const fetchBase = options.fetchBase.replace(/\/+$/, "");
  // <host>/files/<key>/<name>, up to a quote, whitespace, a paren or an entity.
  const fileLink = new RegExp(`(${hosts.map(escape).join("|")})/files/([^"'\\s)<>&]+)`, "g");
  const metaLink = new RegExp(`(content=["'])(?:${hosts.map(escape).join("|")})/files/`, "g");

  const done = new Map<string, boolean>();
  async function copy(host: string, rest: string): Promise<boolean> {
    const key = `${host}/files/${rest}`;
    const known = done.get(key);
    if (known !== undefined) return known;
    const target = join(out, "cms-files", decodeURIComponent(rest));
    let ok = existsSync(target);
    if (!ok) {
      // The file host may be the CMS's public address, which the build
      // machine can't always reach: the same path from fetchBase is the same file.
      let res = await get(key).catch(() => null);
      if (!res?.ok && host !== fetchBase) res = await get(`${fetchBase}/files/${rest}`).catch(() => null);
      if (res?.ok) {
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, Buffer.from(await res.arrayBuffer()));
        result.copied++;
        ok = true;
      } else {
        result.missing.push(`/files/${rest}`);
      }
    }
    done.set(key, ok);
    return ok;
  }

  for await (const file of textFiles(out)) {
    const text = await readFile(file, "utf8");
    const links = [...text.matchAll(fileLink)];
    if (!links.length) continue;
    const copied = new Set<string>();
    for (const [, host, rest] of links) if (await copy(host, rest)) copied.add(rest);
    // Only links to files that were copied are rewritten; the rest stay as
    // they were (and are reported), never pointed at a copy that isn't there.
    const local = (rest: string) => copied.has(rest);
    const next = text
      .replace(new RegExp(metaLink.source + "([^\"'\\s)<>&]+)", "g"), (whole, attr: string, rest: string) =>
        local(rest) && siteUrl ? `${attr}${siteUrl}${LOCAL_PREFIX}${rest}` : whole)
      .replace(fileLink, (whole, _host: string, rest: string) => (local(rest) ? `${LOCAL_PREFIX}${rest}` : whole));
    if (next !== text) {
      await writeFile(file, next);
      result.rewritten++;
    }
    if (next.match(fileLink)) result.left.push("/" + relative(out, file).split(sep).join("/"));
  }
  return result;
}

/**
 * Leaves the CMS's address and token out of a Cloudflare adapter's
 * `.dev.vars` (it copies .env there for `wrangler dev`): a prerendered site
 * reads the CMS only while it builds.
 */
export async function scrubDevVars(serverDir: URL | undefined): Promise<boolean> {
  if (!serverDir) return false;
  const file = fileURLToPath(new URL(".dev.vars", serverDir));
  if (!existsSync(file)) return false;
  const lines = (await readFile(file, "utf8")).split("\n");
  const kept = lines.filter((line) => !/^\s*CMS_(BASE_URL|API_TOKEN)\s*=/.test(line));
  if (kept.length === lines.length) return false;
  await writeFile(file, kept.join("\n"));
  return true;
}
