import { test } from "node:test";
import assert from "node:assert/strict";
import { keepConnection, keepSchema, buildState } from "../dist/build-connection.js";
import { cmsAssets, cmsEntries, cmsGlobals, cmsPages } from "../dist/loaders.js";
import { fakeContext, fakeFetch, fixture } from "./helpers.js";

const schema = fixture("delivery", "schema");
const digest = schema.meta.schema_digest;
const full = fixture("delivery", "content-full");
const delta = fixture("delivery", "content-delta");

function serve(content = full, headers = { "X-CMS-Schema-Digest": digest }) {
  const { fetcher, calls } = fakeFetch({
    "/api/v1/content": { body: content, headers },
    [`/api/v1/content?since=${encodeURIComponent(full.meta.cursor)}`]: { body: delta, headers },
  });
  globalThis.fetch = fetcher;
  return calls;
}

keepConnection({ url: "https://cms.test", token: "t" });
keepSchema(Promise.resolve({ schema: schema.data, digest }));

test("createSchema gives Astro the CMS's schema as Zod and the TypeScript of its entries", async () => {
  const { schema: zod, types } = await cmsPages().createSchema();
  assert.ok(zod.safeParse(full.data.pages[0]).success);
  assert.match(types, /export type Entry = Page;/);
  assert.match(types, new RegExp(`Schema digest: ${digest}`));
  const posts = await cmsEntries("posts").createSchema();
  assert.match(posts.types, /export type Entry = Entries\["posts"\];/);
  await assert.rejects(cmsEntries("nope").createSchema(), /no collection "nope"/);
});

test("loaders load everything, check each record, then apply a delta and drop what stopped being live", async () => {
  buildState().digests.clear();
  serve();
  const pages = fakeContext((await cmsPages().createSchema()).schema);
  await cmsPages().load(pages.context);
  assert.deepEqual([...pages.entries.keys()].sort(), full.data.pages.map((page) => page.path).sort());
  assert.equal(pages.meta.cursor, full.meta.cursor);

  const posts = fakeContext((await cmsEntries("posts").createSchema()).schema);
  await cmsEntries("posts").load(posts.context);
  assert.deepEqual([...posts.entries.keys()], full.data.entries.filter((e) => e.collection === "posts").map((e) => e.slug));

  const globals = fakeContext((await cmsGlobals().createSchema()).schema);
  await cmsGlobals().load(globals.context);
  assert.deepEqual([...globals.entries.keys()], full.data.globals.map((g) => g.slug));

  const assets = fakeContext((await cmsAssets().createSchema()).schema);
  await cmsAssets().load(assets.context);
  assert.deepEqual([...assets.entries.keys()], Object.keys(full.included.assets));

  // The delta (contracts/delivery/content-delta.json): about's title changed, second-post stopped being live.
  const before = pages.entries.get("about").data.title;
  await cmsPages().load(pages.context);
  assert.ok(delta.data.pages.length && delta.data.removed.entries.length, "the delta changes a page and removes an entry");
  for (const changed of delta.data.pages) assert.equal(pages.entries.get(changed.path).data.title, changed.title);
  assert.notEqual(pages.entries.get("about").data.title, before, "the delta was applied");
  for (const gone of delta.data.removed.pages) assert.ok(!pages.entries.has(gone.path), `${gone.path} removed`);
  assert.equal(pages.meta.cursor, delta.meta.cursor);

  await cmsEntries("posts").load(posts.context);
  for (const gone of delta.data.removed.entries.filter((e) => e.collection === "posts")) assert.ok(!posts.entries.has(gone.slug), `${gone.slug} removed`);
  assert.ok(posts.entries.has("first-post"));
});

test("a collection kept from a build against another schema is read whole again", async () => {
  const calls = serve();
  const pages = fakeContext((await cmsPages().createSchema()).schema, { cursor: full.meta.cursor, source: "https://cms.test sha256:older" });
  await cmsPages().load(pages.context);
  assert.ok(calls.every((call) => !call.url.includes("since=")), "no delta across schemas");
  assert.equal(pages.meta.source, `https://cms.test ${digest}`);
});

test("a record outside the schema fails the load, naming it", async () => {
  const bad = structuredClone(full);
  bad.meta.cursor = "bad-cursor";
  bad.data.pages[0].blocks.push({ type: "retired_block", data: {} });
  serve(bad);
  // A cursor the fake doesn't know is answered with the (bad) full snapshot.
  const pages = fakeContext((await cmsPages().createSchema()).schema, { cursor: "unknown-cursor", source: `https://cms.test ${digest}` });
  await assert.rejects(cmsPages().load(pages.context), /retired_block/);
});

test("an answer from another schema during the build stops it", async () => {
  buildState().digests.clear();
  const other = structuredClone(full);
  other.meta.cursor = "other";
  serve(other, { "X-CMS-Schema-Digest": "sha256:somethingelse" });
  const globals = fakeContext((await cmsGlobals().createSchema()).schema, {});
  await assert.rejects(cmsGlobals().load({ ...globals.context, meta: { get: (key) => (key === "source" ? `https://cms.test ${digest}` : "x-unknown"), set() {} } }), /schema changed during the build/);
  buildState().digests.clear();
});
