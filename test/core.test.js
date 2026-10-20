import { test } from "node:test";
import assert from "node:assert/strict";
import { createClient, CmsError } from "../dist/client.js";
import { healthFindings, redirectRules, REDIRECTS_LIVE_IN_THE_CMS } from "../dist/build-checks.js";
import cms from "../dist/index.js";
import { envelope, fakeFetch, fixture } from "./helpers.js";

test("the client sends the token, collects cache tags and schema digests", async () => {
  const { fetcher, calls } = fakeFetch({
    "/api/v1/pages/about": { body: envelope({ path: "about" }), headers: { "Cache-Tag": "page:about,pages", "X-CMS-Schema-Digest": "sha256:abc" } },
  });
  const cms = createClient({ url: "https://cms.test/", token: "t0k", fetch: fetcher });
  const { data } = await cms.page("/about/");
  assert.equal(data.path, "about");
  assert.equal(calls[0].url, "https://cms.test/api/v1/pages/about");
  assert.equal(calls[0].init.headers.Authorization, "Bearer t0k");
  assert.deepEqual([...cms.tags], ["page:about", "pages"]);
  assert.deepEqual([...cms.digests], ["sha256:abc"]);
});

test("the client follows every page of a list and merges the assets", async () => {
  const { fetcher } = fakeFetch({
    "/api/v1/pages?per=100&page=1": { body: envelope([{ path: "a" }], { next_page: 2 }, { assets: { 1: { id: 1 } } }) },
    "/api/v1/pages?per=100&page=2": { body: envelope([{ path: "b" }], { next_page: null }, { assets: { 2: { id: 2 } } }) },
  });
  const cms = createClient({ url: "https://cms.test", token: "t", fetch: fetcher });
  const { data, included } = await cms.pages();
  assert.deepEqual(data.map((page) => page.path), ["a", "b"]);
  assert.deepEqual(Object.keys(included.assets), ["1", "2"]);
});

test("a refused token is a CmsError that says so; a 403 names the capability", async () => {
  const { fetcher } = fakeFetch({
    "/api/v1/site": { body: { error: "unauthorized", message: "…" }, status: 401 },
    "/api/v1/schema": { body: { error: "forbidden", capability: "block_types:read" }, status: 403 },
  });
  const cms = createClient({ url: "https://cms.test", token: "bad", fetch: fetcher });
  await assert.rejects(cms.site(), (error) => error instanceof CmsError && error.status === 401 && /refused/.test(error.message));
  await assert.rejects(cms.schema(), (error) => error.status === 403 && /block_types:read/.test(error.message));
});

test("the client reads the Forms plugin's definition and posts the build report", async () => {
  const definition = fixture("forms", "form-definition");
  const { fetcher, calls } = fakeFetch({
    "/api/x/forms/definition?form=contact": { body: definition },
    "/api/frontend/builds": { body: { ok: true, approval_pending: false }, status: 201 },
  });
  const cms = createClient({ url: "https://cms.test", token: "t", fetch: fetcher });
  assert.equal((await cms.formDefinition("contact")).slug, "contact");
  const answer = await cms.reportBuild({ render: "hybrid", content_cursor: "c1" });
  assert.equal(answer.approval_pending, false);
  assert.equal(calls[1].init.method, "POST");
  assert.deepEqual(JSON.parse(calls[1].init.body), { render: "hybrid", content_cursor: "c1" });
});

test("Site health: the CMS's failing checks become findings", () => {
  const checks = fixture("delivery", "site-health").data;
  assert.ok(checks.every((check) => typeof check.key === "string" && typeof check.message === "string" && ["passes", "fails", "yours_to_judge"].includes(check.state)));
  const findings = healthFindings([...checks, { key: "home_page", state: "fails", message: "No home." }, { key: "x", state: "yours_to_judge", message: "?" }]);
  assert.ok(findings.some((finding) => finding.detail === "No home." && finding.title === "home page"));
  assert.ok(!findings.some((finding) => finding.detail === "?"));
});

test("linkHref turns a CMS link into an href, home at the root", async () => {
  const { linkHref } = await import("../dist/client.js");
  assert.equal(linkHref({ kind: "url", value: "https://x.test" }), "https://x.test");
  assert.equal(linkHref({ kind: "page", value: "home" }), "/");
  assert.equal(linkHref({ kind: "page", value: "about/team" }), "/about/team");
  assert.equal(linkHref({ kind: "page", value: "home" }, { locale: "fr", defaultLocale: "en" }), "/fr");
  assert.equal(linkHref({ kind: "entry", value: "hello", collection: "posts" }), "/posts/hello");
  assert.equal(linkHref(null), undefined);
});

test("recordPath routes by url, and by the record's own path when a canonical points elsewhere", async () => {
  const { recordPath, routeParam } = await import("../dist/client.js");
  const { pages, entries } = fixture("delivery", "content-full").data;
  const site = fixture("delivery", "site").data.url;
  const home = pages.find((page) => page.path === "home");
  const about = pages.find((page) => page.path === "about");
  assert.equal(recordPath(home, { site }), "/");
  // about's SEO canonical is an absolute URL on the site: it's served there.
  assert.equal(about.url, `${site}/about-us`);
  assert.equal(recordPath(about, { site }), "/about-us");
  assert.equal(recordPath(about, { site: "https://elsewhere.test" }), "/about");
  for (const entry of entries) assert.equal(recordPath(entry, { site }), `/${entry.collection}/${entry.slug}`);
  assert.equal(recordPath({ url: "/fr/a-propos", path: "a-propos", locale: "fr" }), "/fr/a-propos");
  assert.equal(recordPath({ url: "https://acme.test/landing", path: "about", locale: "en" }, { site: "https://acme.test" }), "/landing");
  assert.equal(recordPath({ url: "https://partner.test/x", path: "about", locale: "en" }, { site: "https://acme.test" }), "/about");
  assert.equal(recordPath({ url: "https://partner.test/x", path: "home", locale: "fr" }, { site: "https://acme.test", defaultLocale: "en" }), "/fr");
  assert.equal(routeParam({ url: "/", path: "home", locale: "en" }), undefined);
  assert.equal(routeParam({ url: "/posts/hi", collection: "posts", slug: "hi", locale: "en" }), "posts/hi");
});

test("the version reported to the CMS is package.json's", async () => {
  const { VERSION, NAME } = await import("../dist/index.js");
  const { readFile } = await import("node:fs/promises");
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(VERSION, pkg.version);
  assert.equal(NAME, "librepublish");
});

test("the integration's entry loads in plain Node: nothing it imports needs Astro's virtual modules", async () => {
  const { readFile } = await import("node:fs/promises");
  const seen = new Set();
  async function walk(file) {
    if (seen.has(file)) return;
    seen.add(file);
    const source = await readFile(new URL(file, import.meta.url), "utf8");
    assert.doesNotMatch(source, /^(import|export)[^;]*from "astro:/m, `${file} imports an astro: module`);
    for (const [, spec] of source.matchAll(/^(?:import|export)[^;]*from "(\.{1,2}\/[^"]+)"/gm)) await walk(new URL(spec, new URL(file, import.meta.url)).href);
  }
  await walk("../dist/index.js");
  assert.ok(seen.size > 5);
});

test("sitemap.xml keeps only what the site serves: built pages and on-demand routes", async () => {
  const { servedSitemap } = await import("../dist/sitemap-filter.js");
  const url = (loc) => `  <url>\n    <loc>${loc}</loc>\n  </url>\n`;
  const xml = `<?xml version="1.0"?>\n<urlset>\n${url("https://acme.test/")}${url("https://acme.test/about")}${url("https://acme.test/categories/appetizer")}${url("https://acme.test/live/x")}${url("https://acme.test/posts/a&amp;b")}</urlset>\n`;
  const { xml: kept, removed } = servedSitemap(xml, ["", "about/", "posts/a&b"], [/^\/live(?:\/(.*?))?\/?$/]);
  assert.deepEqual(removed, ["/categories/appetizer"]);
  assert.match(kept, /acme\.test\/about/);
  assert.match(kept, /acme\.test\/live\/x/);
  assert.match(kept, /a&amp;b/);
  assert.doesNotMatch(kept, /appetizer/);
});

test("the webhook URL the build reports matches the route under the site's trailingSlash", async () => {
  const { webhookPath } = await import("../dist/index.js");
  assert.equal(webhookPath("always"), "/_cms/webhook/");
  assert.equal(webhookPath("never"), "/_cms/webhook");
  assert.equal(webhookPath("ignore"), "/_cms/webhook");
  assert.equal(webhookPath(undefined), "/_cms/webhook");
});

test("sitemap URLs take the site's trailingSlash form", async () => {
  const { slashed } = await import("../dist/sitemap-filter.js");
  const site = "https://acme.test";
  assert.equal(slashed("https://acme.test/about", "always", site), "https://acme.test/about/");
  assert.equal(slashed("https://acme.test/about/", "always", site), "https://acme.test/about/");
  assert.equal(slashed("https://acme.test/fr/a-propos?x=1#y", "always", site), "https://acme.test/fr/a-propos/?x=1#y");
  assert.equal(slashed("https://acme.test/about/", "never", site), "https://acme.test/about");
  assert.equal(slashed("https://acme.test/about", "ignore", site), "https://acme.test/about");
  assert.equal(slashed("https://acme.test/about", undefined, site), "https://acme.test/about");
  assert.equal(slashed("https://acme.test/", "never", site), "https://acme.test/");
  assert.equal(slashed("https://acme.test", "always", site), "https://acme.test");
  assert.equal(slashed("https://acme.test/feed.xml", "always", site), "https://acme.test/feed.xml");
  assert.equal(slashed("https://elsewhere.test/about", "always", site), "https://elsewhere.test/about");
  assert.equal(slashed("/posts/hello", "always"), "/posts/hello/");
});

test("the delivery fixtures have the shapes the runtime routes read", () => {
  const sitemap = fixture("delivery", "sitemap");
  for (const url of sitemap.data) {
    assert.deepEqual(Object.keys(url).sort(), ["alternates", "lastmod", "loc", "locale", "path", "type"]);
  }
  const robots = fixture("delivery", "robots").data;
  assert.equal(typeof robots.text, "string");
  assert.ok(["generated", "custom"].includes(robots.mode));
  const site = fixture("delivery", "site");
  assert.equal(typeof site.meta.cms_url, "string");
  assert.deepEqual(site.data.image_widths, [640, 1280, 1920]);
  assert.equal(typeof site.meta.cms_version, "string");
  assert.equal(site.data.plugin_config.forms.list, "/api/x/forms/list");
  assert.ok(Array.isArray(fixture("delivery", "redirects").data));
});

test("redirects live in the CMS: a site's own rules are found, comments aren't", () => {
  assert.deepEqual(redirectRules(""), []);
  assert.deepEqual(redirectRules("# a comment\n\n   \n# From the CMS (Tools › Redirects)\n"), []);
  assert.deepEqual(redirectRules("/old /new 301\n# note\n  /a/* /b/:splat 302  \n"), ["/old /new 301", "/a/* /b/:splat 302"]);
});

test("redirects live in the CMS: cms({ redirects }) is refused", () => {
  assert.throws(() => cms({ redirects: false }), (e) => e.message.includes(REDIRECTS_LIVE_IN_THE_CMS));
  assert.throws(() => cms({ redirects: true }), /is gone/);
  assert.doesNotThrow(() => cms({}));
});

test("redirects live in the CMS: astro.config's redirects stop the build", async () => {
  const hook = cms({}).hooks["astro:config:setup"];
  const args = (redirects) => ({
    config: { root: new URL("file:///tmp/site/"), trailingSlash: "ignore", redirects },
    command: "build", updateConfig() {}, injectRoute() {}, addMiddleware() {}, addWatchFile() {},
    logger: { info() {}, warn() {}, error() {} },
  });
  await assert.rejects(hook(args({ "/old": "/new" })), (e) => e.message.includes(REDIRECTS_LIVE_IN_THE_CMS) && e.message.includes("/old"));
});
