/**
 * The CMS lists every published page and entry in the sitemap, including
 * entries of collections the site never gives a page (a categories pool, a
 * list of partners). After a build the site knows what it serves: the pages
 * it built, and the routes it renders on demand. A URL that's neither would
 * be a 404, so it comes out of the sitemap.xml the build wrote, and the build
 * says which.
 */
export function servedSitemap(
  xml: string,
  built: Iterable<string>,
  onDemand: RegExp[],
): { xml: string; removed: string[] } {
  const served = new Set([...built].map(normalize));
  const removed: string[] = [];
  const kept = xml.replace(/[ \t]*<url>[\s\S]*?<\/url>\n?/g, (block) => {
    const loc = block.match(/<loc>([^<]*)<\/loc>/)?.[1];
    if (!loc) return block;
    const path = normalize(pathOf(unescape(loc)));
    if (served.has(path) || onDemand.some((pattern) => pattern.test(path) || pattern.test(`${path}/`))) return block;
    removed.push(path);
    return "";
  });
  return { xml: kept, removed };
}

function pathOf(loc: string): string {
  try {
    return decodeURI(new URL(loc, "https://site.invalid").pathname);
  } catch {
    return loc;
  }
}

function normalize(path: string): string {
  const clean = `/${path.replace(/^\/+/, "")}`.replace(/\/index\.html$|\.html$/, "");
  return clean.length > 1 ? clean.replace(/\/+$/, "") : "/";
}

function unescape(value: string): string {
  return value.replace(/&quot;/g, '"').replace(/&gt;/g, ">").replace(/&lt;/g, "<").replace(/&amp;/g, "&");
}
