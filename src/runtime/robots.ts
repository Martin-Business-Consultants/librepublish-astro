/**
 * /robots.txt: the site's own, from the CMS (GET /api/v1/robots: written in
 * the CMS, or made from Settings › Search), with the sitemap's address added
 * when the CMS's text doesn't name one. Prerendered. A site with its own
 * public/robots.txt keeps that one (the integration doesn't add this route then).
 */
import type { APIRoute } from "astro";
import { runtimeClient } from "./env.js";

export const prerender = true;

export const GET: APIRoute = async ({ site }) => {
  const { data } = await runtimeClient().robots();
  let text = data.text.endsWith("\n") ? data.text : `${data.text}\n`;
  if (!/^sitemap:/im.test(text)) {
    text += `\nSitemap: ${site ? new URL("/sitemap.xml", site).href : "/sitemap.xml"}\n`;
  }
  return new Response(text, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
};
