// The build's launch checklist items (src/launch-checks.ts) and the CMS's
// files served by the site (src/local-files.ts), on a built site made in a
// temporary directory.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { localizeFiles, scrubDevVars } from "../dist/local-files.js";
import { envChecks, formsCheck, mediaCheck, prerenderCheck, secretsCheck, siteChecks, siteFilesCheck } from "../dist/launch-checks.js";

const CMS = "https://cms.acme.example";
const BUILD_CMS = "http://localhost:8086";

async function built(files) {
  const root = await mkdtemp(join(tmpdir(), "launch-"));
  for (const [path, text] of Object.entries(files)) {
    await mkdir(join(root, path, ".."), { recursive: true });
    await writeFile(join(root, path), text);
  }
  return pathToFileURL(root + "/");
}

// The CMS's files: one there, one whose file is gone.
const files = async (url) => {
  const u = String(url);
  if (u.endsWith("/files/abc/hero.png")) return new Response(new Uint8Array([1, 2, 3]));
  return new Response("not found", { status: 404 });
};

test("localizeFiles copies the files pages link and points the links at the copies", async () => {
  const dir = await built({
    "index.html": `<meta property="og:image" content="${CMS}/files/abc/hero.png"><img src="${BUILD_CMS}/files/abc/hero.png"><img src="${CMS}/files/gone/x.png"><form action="${CMS}/api/x/forms/submit">`,
    "about/index.html": `<p>no files</p>`,
  });
  const result = await localizeFiles({ clientDir: dir, hosts: [BUILD_CMS, CMS], fetchBase: BUILD_CMS, siteUrl: "https://acme.example", fetch: files });
  const html = await readFile(new URL("index.html", dir), "utf8");
  assert.equal(result.copied, 1);
  assert.ok(existsSync(new URL("cms-files/abc/hero.png", dir)));
  assert.match(html, /content="https:\/\/acme\.example\/cms-files\/abc\/hero\.png"/, "meta tags get the site's absolute address");
  assert.match(html, /<img src="\/cms-files\/abc\/hero\.png">/);
  assert.match(html, /cms\.acme\.example\/files\/gone\/x\.png/, "a file the CMS couldn't give stays linked where it was");
  assert.match(html, /cms\.acme\.example\/api\/x\/forms\/submit/, "the forms' address isn't a file");
  assert.deepEqual(result.missing, ["/files/gone/x.png"]);
  assert.deepEqual(result.left, ["/index.html"]);
  assert.equal(mediaCheck(result, false).state, "fails");
});

test("scrubDevVars leaves the CMS's address and token out of .dev.vars", async () => {
  const dir = await built({ ".dev.vars": "CMS_BASE_URL=http://x\nCMS_API_TOKEN=lps_secret\nSTELLA=1\n" });
  assert.equal(await scrubDevVars(dir), true);
  assert.equal(await readFile(new URL(".dev.vars", dir), "utf8"), "STELLA=1\n");
  assert.equal(await scrubDevVars(dir), false);
});

test("prerenderCheck: static passes; undeclared on-demand routes warn, then fail once a list is given", () => {
  assert.equal(prerenderCheck([], undefined).state, "passes");
  assert.equal(prerenderCheck(["/api/quote-hook"], undefined).state, "warns");
  assert.equal(prerenderCheck(["/api/quote-hook"], ["/api/quote-hook"]).state, "passes");
  const lost = prerenderCheck(["/api/quote-hook", "/about"], ["/api/quote-hook"]);
  assert.equal(lost.state, "fails");
  assert.match(lost.evidence, /\/about/);
});

test("secretsCheck finds the token in any built file, and the CMS's address in the server's", async () => {
  const client = await built({ "index.html": "<p>ok</p>" });
  const server = await built({ "entry.mjs": `fetch("${BUILD_CMS}/api/v1/site")` });
  assert.equal((await secretsCheck({ dirs: [client], token: "lps_secret", cmsUrl: BUILD_CMS, onDemand: false })).state, "passes");
  const address = await secretsCheck({ dirs: [client, server], serverDir: server, token: "lps_secret", cmsUrl: BUILD_CMS, onDemand: false });
  assert.equal(address.state, "warns");
  const leaked = await built({ "chunk.js": `const t = "lps_secret"` });
  const token = await secretsCheck({ dirs: [leaked], token: "lps_secret", cmsUrl: BUILD_CMS, onDemand: false });
  assert.equal(token.state, "fails");
  assert.doesNotMatch(token.evidence, /lps_secret/, "the evidence never repeats the token");
});

test("formsCheck: the forms pages draw exist and are open", async () => {
  const forms = [{ slug: "contact", name: "Contact", open: true, digest: "" }, { slug: "old", name: "Old", open: false, digest: "" }];
  const island = await built({ "_astro/ContactIsland.js": `x({slug:"contact",cms:y})` });
  assert.equal((await formsCheck(island, forms)).state, "passes");
  const minified = await built({ "_astro/ContactIsland.js": "m(S,{slug:`contact`,get cms(){}})" });
  assert.equal((await formsCheck(minified, forms)).state, "passes", "a minifier's template literal");
  const staticForm = await built({ "index.html": `<astro-island props="{&quot;slug&quot;:[0,&quot;quote&quot;]}">` });
  const missing = await formsCheck(staticForm, forms);
  assert.equal(missing.state, "fails");
  assert.match(missing.evidence, /quote/);
  const closed = await built({ "index.html": `<astro-island props="{&quot;slug&quot;:[0,&quot;old&quot;]}">` });
  assert.match((await formsCheck(closed, forms)).evidence, /aren't taking submissions: old/);
  assert.equal((await formsCheck(await built({ "index.html": "" }), forms)).state, "n_a");
  assert.equal((await formsCheck(island, null)).state, "unknown");
});

test("siteFilesCheck names what wasn't built", async () => {
  const dir = await built({ "robots.txt": "", "404.html": "" });
  const check = siteFilesCheck(dir, true);
  assert.equal(check.state, "fails");
  assert.match(check.evidence, /sitemap\.xml/);
});

test("envChecks: build variables by name only; runtime ones are a manual item", () => {
  const [build, runtime] = envChecks({ build: ["CMS_BASE_URL", "GETOUTSEND_API_KEY"], runtime: ["CMS_FORM_HOOK_SECRET"] }, (name) => name === "CMS_BASE_URL");
  assert.equal(build.state, "fails");
  assert.match(build.evidence, /GETOUTSEND_API_KEY/);
  assert.equal(runtime.manual, true);
  assert.match(runtime.title, /CMS_FORM_HOOK_SECRET/);
  assert.deepEqual(envChecks(undefined, () => true), []);
});

test("siteChecks: run ones report, a throw is unknown, the rest are a person's to tick", async () => {
  const checks = await siteChecks([
    { key: "ids", title: "Lily Pad ids set", run: () => true },
    { key: "stella", title: "Stella receives leads", launch: true },
    { key: "prices", title: "Prices load", run: () => ({ state: "warns", evidence: "2 of 3" }) },
    { key: "boom", title: "Boom", run: () => { throw new Error("nope"); } },
  ]);
  assert.deepEqual(checks.map((c) => [c.key, c.state ?? (c.manual ? "manual" : "")]), [
    ["site.ids", "passes"], ["site.stella", "manual"], ["site.prices", "warns"], ["site.boom", "unknown"],
  ]);
  await assert.rejects(() => siteChecks([{ key: "Bad Key", title: "x" }]), /isn't a key/);
});
