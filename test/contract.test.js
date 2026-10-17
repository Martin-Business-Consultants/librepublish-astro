// The integration's half of the contract gate (contracts/README.md). The Go
// half, TestContract, holds the CMS to contracts/**; this holds the
// integration to the same files: its canonical JSON reproduces the CMS's
// digests, its runtime reads the recorded headers and webhooks, and
// contracts/ is the one it was last checked against (test/contracts.sha256).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { canonicalJson, digestOf, formDigest } from "../dist/schema/digest.js";
import { SCHEMA_DIGEST_HEADER } from "../dist/client.js";
import { plan } from "../dist/runtime/purge.js";
import { contractSums, pinFile } from "./contracts-pin.mjs";
import { contractIndex, contracts, fixture } from "./helpers.js";

const index = contractIndex();
const schema = fixture("delivery", "schema");

test("contracts/ is the one this package was last checked against", () => {
  const pinned = readFileSync(pinFile, "utf8");
  const now = contractSums();
  if (pinned === now) return;
  const lines = (text) => new Map(text.trim().split("\n").map((line) => line.split("  ").reverse()));
  const [was, is] = [lines(pinned), lines(now)];
  const changed = [...new Set([...was.keys(), ...is.keys()])].filter((file) => was.get(file) !== is.get(file)).sort();
  assert.fail(
    `contracts/ changed since packages/astro was checked against it: ${changed.join(", ")}.\n` +
    "A contract change is an API change: update packages/astro (types, validation, tests) for it, " +
    "then run `npm run contracts:pin` in packages/astro and commit both.",
  );
});

test("the integration's canonical JSON reproduces the CMS's schema digest", () => {
  const digest = digestOf(schema.data);
  assert.match(digest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(digest, schema.meta.schema_digest, "meta.schema_digest");

  // Every token-authed /api/v1 answer carries the same digest in its header.
  const delivery = Object.entries(index).filter(([file]) => file.startsWith("delivery/"));
  assert.ok(delivery.length > 10);
  for (const [file, { headers }] of delivery) assert.equal(headers[SCHEMA_DIGEST_HEADER], digest, `${file}: ${SCHEMA_DIGEST_HEADER}`);
  // And schema.changed announces it.
  assert.equal(fixture("webhooks", "schema.changed").data.schema_digest, digest);
});

test("the integration's canonical JSON reproduces the Forms plugin's form digests", () => {
  const { form } = fixture("forms", "form-definition");
  assert.equal(formDigest(form), form.digest, "the definition's digest: every key but digest");
  const listed = fixture("forms", "form-list").forms.find((item) => item.slug === form.slug);
  assert.equal(listed.digest, form.digest, "the list carries the same digest");
  // Of the canonical form, not the bytes as served: key order doesn't matter.
  assert.equal(formDigest(JSON.parse(JSON.stringify(Object.fromEntries(Object.entries(form).reverse())))), form.digest);
});

test("the recorded files are canonical JSON's content: they parse, and every one the index names exists", () => {
  for (const [file, entry] of Object.entries(index)) {
    assert.ok(existsSync(new URL(file, contracts)), file);
    assert.equal(typeof entry.request.method, "string", file);
    assert.doesNotThrow(() => canonicalJson(JSON.parse(readFileSync(new URL(file, contracts), "utf8"))), file);
  }
  assert.equal(index["delivery/page-home.json"].request.path, "/api/v1/pages/home", "the home page's path is home");
  assert.equal(index["delivery/page-about.json"].request.path, "/api/v1/pages/about");
  assert.equal(index["forms/form-submit-422.json"].status, 422);
  assert.equal(index["forms/form-submit-410.json"].status, 410);
});

test("every recorded webhook asks /_cms/webhook for what the event means", () => {
  const contract = JSON.parse(readFileSync(new URL("webhook_contract.json", contracts), "utf8")).webhook;
  const webhooks = Object.entries(index).filter(([file]) => file.startsWith("webhooks/"));
  assert.ok(webhooks.length >= 6);
  for (const [file, { headers }] of webhooks) {
    const body = JSON.parse(readFileSync(new URL(file, contracts), "utf8"));
    assert.deepEqual(Object.keys(body).sort(), [...contract.envelope_keys].sort(), file);
    assert.equal(headers["X-CMS-Event"], body.event, file);
    assert.match(headers[contract.signature_header], /^sha256=/);
    const keys = body.event.startsWith("page.") ? contract.page_data_keys : body.event.startsWith("entry.") ? contract.entry_data_keys
      : body.event === "schema.changed" ? contract.schema_data_keys : null;
    if (keys) assert.deepEqual(Object.keys(body.data).sort(), [...keys].sort(), `${file}: data keys`);

    const todo = plan(body);
    const data = body.data;
    if (body.event.startsWith("page.")) assert.deepEqual(todo, { kind: "purge", all: false, tags: [`page:${data.path}`, "pages", "sitemap"] }, file);
    else if (body.event.startsWith("entry.")) assert.deepEqual(todo, { kind: "purge", all: false, tags: [`entry:${data.collection_slug}/${data.slug}`, `collection:${data.collection_slug}`, "sitemap"] }, file);
    else if (body.event === "global.updated") assert.deepEqual(todo, { kind: "purge", all: false, tags: [`global:${data.slug}`] }, file);
    else if (body.event === "schema.changed") {
      assert.equal(todo.kind, "rebuild", file);
      assert.equal(todo.schema_digest, schema.meta.schema_digest);
    } else assert.fail(`${file}: an event /_cms/webhook doesn't know (${body.event})`);
  }
});
