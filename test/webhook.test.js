import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { verify } from "../dist/runtime/signature.js";
import { plan } from "../dist/runtime/purge.js";

const contract = JSON.parse(readFileSync(new URL("../../../contracts/webhook_contract.json", import.meta.url), "utf8")).webhook;
const sign = (body, secret) => `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

test("the signature is the contract's: X-CMS-Signature, sha256=<hex HMAC-SHA256 of the raw body>", async () => {
  assert.equal(contract.signature_header, "X-CMS-Signature");
  assert.match(contract.signature_format, /^sha256=<hex HMAC-SHA256 of the raw request body>$/);
  const body = JSON.stringify(contract.example);
  const good = sign(body, "s3cret");
  assert.equal(await verify(body, good, "s3cret"), true);
  assert.equal(await verify(body, good, "other"), false);
  assert.equal(await verify(`${body} `, good, "s3cret"), false);
  assert.equal(await verify(body, good.replace("sha256=", ""), "s3cret"), false);
  assert.equal(await verify(body, null, "s3cret"), false);
});

test("the deploy's purge ({tags, reason}) purges its tags, or everything when it names none", () => {
  assert.deepEqual(plan({ tags: ["page:about", "sitemap"], reason: "publish" }), { kind: "purge", all: false, tags: ["page:about", "sitemap"] });
  assert.deepEqual(plan({ tags: [], reason: "manual" }), { kind: "purge", all: true, tags: [] });
});

test("contract events: the example page event purges the page; entries their collection", () => {
  assert.deepEqual(contract.envelope_keys, ["event", "tenant", "delivered_at", "data"]);
  assert.deepEqual(plan(contract.example), { kind: "purge", all: false, tags: ["page:about", "pages", "sitemap"] });
  const entry = { event: "entry.published", tenant: "acme", delivered_at: "2026-09-17T10:00:00Z", data: Object.fromEntries(contract.entry_data_keys.map((k) => [k, k === "collection_slug" ? "posts" : k === "slug" ? "hi" : "x"])) };
  assert.deepEqual(plan(entry), { kind: "purge", all: false, tags: ["entry:posts/hi", "collection:posts", "sitemap"] });
  assert.equal(plan({ event: "submission.created", data: {} }).kind, "ignore");
});

test("schema.changed asks for a rebuild, not a purge", () => {
  const todo = plan({ event: "schema.changed", tenant: "acme", delivered_at: "2026-10-17T10:00:00Z", data: { schema_digest: "sha256:abc" } });
  assert.equal(todo.kind, "rebuild");
  assert.equal(todo.schema_digest, "sha256:abc");
  assert.match(todo.reason, /librepublish-astro sync/);
});
