/**
 * What a build holds the site to: Site health's checks from the CMS (GET
 * /api/v1/site_health: the site's URL, meta descriptions, a home page, alt
 * text…), and the built site's own (a sitemap, robots.txt, a 404 page).
 * Failing ones are warned about — or stop the build with `siteHealth: "error"`.
 */
import { access } from "node:fs/promises";
import type { CmsHealthCheck } from "./types.js";

export interface Finding { title: string; detail: string }

export async function siteFindings(dir: URL): Promise<Finding[]> {
  const exists = async (file: string) => access(new URL(file, dir)).then(() => true, () => false);
  const findings: Finding[] = [];
  if (!(await exists("sitemap.xml"))) findings.push({ title: "No sitemap.xml", detail: "Search engines read it to find every page. cms() adds one unless sitemap: false." });
  if (!(await exists("robots.txt"))) findings.push({ title: "No robots.txt", detail: "It tells crawlers where the sitemap is." });
  if (!(await exists("404.html"))) findings.push({ title: "No 404 page", detail: "Add src/pages/404.astro so a missing page looks like the site." });
  return findings;
}

/** The CMS's checks that fail ("yours to judge" ones are left to a person). */
export function healthFindings(checks: CmsHealthCheck[]): Finding[] {
  return checks.filter((check) => check.state === "fails").map((check) => ({ title: check.key.replace(/_/g, " "), detail: check.message }));
}

/**
 * Redirects live in the CMS (Tools › Redirects) and nowhere else: the build
 * writes them to _redirects, and a site that defines its own — Astro's
 * `redirects`, or rules in public/_redirects — stops the build. Two places to
 * keep a redirect means one of them goes stale; the CMS is the one editors see.
 */
export const REDIRECTS_LIVE_IN_THE_CMS =
  "Redirects live in the CMS (Tools › Redirects), not in the site. Move them there and remove them from the site";

/** The rules a _redirects file holds, ignoring comments and blank lines. */
export function redirectRules(text: string): string[] {
  return text.split("\n").map((line) => line.trim()).filter((line) => line && !line.startsWith("#"));
}
