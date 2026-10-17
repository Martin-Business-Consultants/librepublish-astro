import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { accepted, decide, describeChanges, lockFrom, readLock, writeLock, LOCK_FILE } from "../dist/lock.js";
import { readLive } from "../dist/schema/live.js";
import { createClient } from "../dist/client.js";
import { main } from "../dist/cli.js";
import { contractIndex, envelope, fakeFetch, fixture } from "./helpers.js";

const live = (digest, parts = {}) => ({ cmsUrl: "https://cms.test", apiVersion: "v1", cmsVersion: "dev", digest, parts, forms: {} });

test("same digest: every command goes on", () => {
  const lock = lockFrom(live("sha256:a"));
  for (const command of ["dev", "build", "sync", "preview"]) assert.deepEqual(decide(lock, live("sha256:a"), { command, accept: false }), { action: "ok" });
});

test("a moved schema fails build and sync (astro check), naming what changed and what to run", () => {
  const lock = lockFrom(live("sha256:aaaa", { "blocks/hero": "1", "blocks/old": "2", seo: "3" }));
  const now = live("sha256:bbbb", { "blocks/hero": "9", "blocks/promo": "4", seo: "3" });
  for (const command of ["build", "sync"]) {
    const decision = decide(lock, now, { command, accept: false });
    assert.equal(decision.action, "fail");
    assert.match(decision.message, /\+ blocks\/promo/);
    assert.match(decision.message, /- blocks\/old/);
    assert.match(decision.message, /~ blocks\/hero/);
    assert.doesNotMatch(decision.message, /seo/);
    assert.match(decision.message, /npx librepublish-astro sync/);
  }
});

test("dev takes the new schema with a warning; LIBREPUBLISH_ACCEPT_SCHEMA=1 takes it anywhere", () => {
  const lock = lockFrom(live("sha256:aaaa"));
  const dev = decide(lock, live("sha256:bbbb"), { command: "dev", accept: false });
  assert.equal(dev.action, "write");
  assert.equal(dev.level, "warn");
  const ci = decide(lock, live("sha256:bbbb"), { command: "build", accept: true });
  assert.equal(ci.action, "write");
  assert.equal(accepted({ LIBREPUBLISH_ACCEPT_SCHEMA: "1" }), true);
  assert.equal(accepted({ LIBREPUBLISH_ACCEPT_SCHEMA: "0" }), false);
  assert.equal(accepted({}), false);
});

test("no lock: a build stops; dev and an accepted build write one", () => {
  assert.equal(decide(null, live("sha256:a"), { command: "build", accept: false }).action, "fail");
  assert.equal(decide(null, live("sha256:a"), { command: "sync", accept: false }).action, "fail");
  assert.equal(decide(null, live("sha256:a"), { command: "dev", accept: false }).action, "write");
  assert.equal(decide(null, live("sha256:a"), { command: "build", accept: true }).action, "write");
});

test("describeChanges lists added, removed and changed parts, sorted", () => {
  assert.deepEqual(describeChanges({ a: "1", b: "2", c: "3" }, { b: "2", c: "4", d: "5" }), ["- a", "~ c", "+ d"]);
});

test("the lock is read and written as committed JSON", async () => {
  const root = await mkdtemp(join(tmpdir(), "lp-lock-"));
  assert.equal(await readLock(root), null);
  await writeLock(root, lockFrom(live("sha256:a", { "blocks/x": "1" })));
  const text = await readFile(join(root, LOCK_FILE), "utf8");
  assert.ok(text.endsWith("}\n"));
  assert.equal((await readLock(root)).schema_digest, "sha256:a");
  await writeFile(join(root, LOCK_FILE), JSON.stringify({ lock_version: 9 }));
  await assert.rejects(readLock(root), /librepublish-astro sync/);
});

function cms() {
  const schema = fixture("delivery", "schema");
  const headers = contractIndex()["delivery/schema.json"].headers;
  return fakeFetch({
    "/api/v1/site": { body: fixture("delivery", "site"), headers },
    "/api/v1/schema": { body: schema, headers },
    "/api/x/forms/list": { body: fixture("forms", "form-list") },
  });
}

test("readLive takes the CMS's digest and version, a digest per part, and each form's", async () => {
  const schema = fixture("delivery", "schema");
  const client = createClient({ url: "https://cms.test", token: "t", fetch: cms().fetcher });
  const read = await readLive(client, await client.site(), "https://cms.test");
  assert.equal(read.live.digest, schema.meta.schema_digest);
  assert.equal(read.live.cmsVersion, schema.meta.cms_version);
  assert.ok(read.live.parts["blocks/hero"]);
  assert.ok(!read.live.parts["blocks/pattern"]);
  assert.deepEqual(read.live.forms, Object.fromEntries(fixture("forms", "form-list").forms.map((f) => [f.slug, f.digest])));
  assert.equal(lockFrom(read.live).cms_version, "dev");

  // A CMS that sends no digest is older than this package reads.
  const old = createClient({ url: "https://cms.test", token: "t", fetch: fakeFetch({ "/api/v1/schema": { body: envelope(schema.data) } }).fetcher });
  await assert.rejects(readLive(old, null, "https://cms.test"), /no schema digest/);
});

test("librepublish-astro sync writes the lock; check exits 1 once the CMS moves", async () => {
  const root = await mkdtemp(join(tmpdir(), "lp-cli-"));
  const lines = [];
  const out = (line) => lines.push(line);
  process.env.CMS_BASE_URL = "https://cms.test";
  process.env.CMS_API_TOKEN = "t";
  const saved = globalThis.fetch;
  try {
    globalThis.fetch = cms().fetcher;
    assert.equal(await main(["check", "--root", root], out), 1, "no lock yet");
    assert.equal(await main(["sync", "--root", root], out), 0);
    assert.equal((await readLock(root)).schema_digest, fixture("delivery", "schema").meta.schema_digest);
    assert.equal(await main(["check", "--root", root], out), 0);

    const moved = fixture("delivery", "schema");
    moved.data.blocks.promo = { type: "object", additionalProperties: false, properties: {}, required: [] };
    moved.meta.schema_digest = "sha256:moved";
    globalThis.fetch = fakeFetch({
      "/api/v1/site": { body: fixture("delivery", "site") },
      "/api/v1/schema": { body: moved },
      "/api/x/forms/list": { body: fixture("forms", "form-list") },
    }).fetcher;
    lines.length = 0;
    assert.equal(await main(["check", "--root", root], out), 1);
    assert.match(lines.join("\n"), /\+ blocks\/promo/);
  } finally {
    globalThis.fetch = saved;
    delete process.env.CMS_BASE_URL;
    delete process.env.CMS_API_TOKEN;
  }
});
