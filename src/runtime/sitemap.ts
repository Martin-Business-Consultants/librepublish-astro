/**
 * /sitemap.xml, from the CMS (GET /api/v1/sitemap): every URL it lists, with
 * lastmod and hreflang alternates. The CMS gives absolute URLs once Settings ›
 * General has the site's URL, paths until then: those are made absolute on
 * the site (`site` in astro.config, or the CMS's), and given the site's
 * `trailingSlash` form, so they match its canonical URLs. Prerendered.
 */
import type { APIRoute } from "astro";
import { slashed } from "../sitemap-filter.js";
import { runtimeClient } from "./env.js";

/** astro.config's `trailingSlash`, set by the integration at build time. */
declare const __LIBREPUBLISH_TRAILING_SLASH__: string | undefined;
const TRAILING_SLASH = typeof __LIBREPUBLISH_TRAILING_SLASH__ === "string" ? __LIBREPUBLISH_TRAILING_SLASH__ : undefined;

export const prerender = true;

export const GET: APIRoute = async ({ site }) => {
  const { data } = await runtimeClient().sitemap();
  const absolute = (url: string) => slashed(site ? new URL(url, site).href : url, TRAILING_SLASH, site);
  const urls = data.map((url) => [
    "  <url>",
    `    <loc>${escape(absolute(url.loc || url.path))}</loc>`,
    url.lastmod ? `    <lastmod>${escape(url.lastmod)}</lastmod>` : null,
    ...url.alternates.map((alt) => `    <xhtml:link rel="alternate" hreflang="${escape(alt.hreflang)}" href="${escape(absolute(alt.href))}"/>`),
    "  </url>",
  ].filter(Boolean).join("\n"));

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">
${urls.join("\n")}
</urlset>
`;
  return new Response(xml, { headers: { "Content-Type": "application/xml; charset=utf-8" } });
};

function escape(value: string) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
