// POST /_cms/checks (src/runtime/checks-answer.ts): signed with either
// secret the site shares with the CMS, it says which one verified and which
// runtime variables are set — names and booleans, never a value.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { answerChecks } from "../dist/runtime/checks-answer.js";

const now = 1_800_000_000_000;
const signed = (body, secret, at = now / 1000) => new Headers({
  "X-CMS-Timestamp": String(at),
  "X-CMS-Signature-V2": "sha256=" + createHmac("sha256", secret).update(`${at}.${body}`).digest("hex"),
});
const env = { CMS_WEBHOOK_SECRET: "purge", CMS_FORM_HOOK_SECRET: "hook", STELLA_WEBHOOK_URL: "https://stella.test/x" };
const secret = (name) => env[name];
const runtime = ["CMS_FORM_HOOK_SECRET", "STELLA_WEBHOOK_URL", "GETOUTSEND_API_KEY"];
const body = JSON.stringify({ nonce: "n1" });

test("signed with the purge secret: which variables are set, never their values", async () => {
  const answer = await answerChecks(body, signed(body, "purge"), secret, runtime, "0.8.0", now);
  assert.equal(answer.status, 200);
  assert.equal(answer.body.verified_with, "webhook");
  assert.deepEqual(answer.body.env, { CMS_FORM_HOOK_SECRET: true, STELLA_WEBHOOK_URL: true, GETOUTSEND_API_KEY: false });
  assert.doesNotMatch(JSON.stringify(answer.body), /stella\.test|"purge"|"hook"/);
});

test("signed with a form's hook secret: the site shares it", async () => {
  const answer = await answerChecks(body, signed(body, "hook"), secret, runtime, "0.8.0", now);
  assert.equal(answer.status, 200);
  assert.equal(answer.body.verified_with, "form_hook");
});

test("any other signature, an old one, or none: 401 and nothing else", async () => {
  for (const headers of [signed(body, "wrong"), signed(body, "purge", now / 1000 - 3600), new Headers()]) {
    const answer = await answerChecks(body, headers, secret, runtime, "0.8.0", now);
    assert.equal(answer.status, 401);
    assert.deepEqual(Object.keys(answer.body), ["error"]);
  }
  const unset = await answerChecks(body, signed(body, "purge"), () => undefined, runtime, "0.8.0", now);
  assert.equal(unset.status, 401, "a site with neither secret set answers nothing");
});
