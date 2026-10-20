import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHmac } from "node:crypto";
import { check, postedFrom, sentence, shown, validate } from "../dist/forms/rules.js";
import { answer, formHook, FormHookRefusal } from "../dist/forms/hook.js";
import { clientRules } from "../dist/forms/definition.js";
import { FIELD_TYPES } from "../dist/forms/types.js";
import { contractIndex, fixture } from "./helpers.js";

const { form } = fixture("forms", "form-definition");
const fields = clientRules(form).fields;
const field = (name) => fields.find((f) => f.name === name);
const one = (values) => ({ values: Object.fromEntries(Object.entries(values).map(([k, v]) => [k, [].concat(v)])) });

test("the definition carries a rule set for every field that posts, and none for layout", () => {
  for (const f of form.fields) {
    if (f.type === "heading") assert.equal(f.rules, undefined, "a heading has no rules");
    else assert.equal(typeof f.rules?.required, "boolean", `${f.name}: rules.required`);
  }
  assert.deepEqual(fields.map((f) => f.name), form.fields.filter((f) => f.type !== "heading").map((f) => f.name));
});

/** A recorded post (contracts/index.json's request body) as the validator takes it: every value a string. */
const postedBody = (name) => {
  const body = contractIndex()[`forms/${name}.json`].request.body;
  return { values: Object.fromEntries(Object.entries(body).map(([k, v]) => [k, [].concat(v).map(String)])) };
};

test("the validator reaches the server's verdict on the submission it refused (form-submit-422)", () => {
  const server = fixture("forms", "form-submit-422");
  assert.equal(server.error, "invalid");
  assert.deepEqual(validate(fields, postedBody("form-submit-422")), server.errors);
});

test("the validator lets through the submission the server took (form-submit-200)", () => {
  assert.equal(fixture("forms", "form-submit-200").ok, true);
  assert.deepEqual(validate(fields, postedBody("form-submit-200")), {});
});

test("each rule, with the server's words", () => {
  assert.deepEqual(check(field("name"), one({ name: "x".repeat(81) })), ["is longer than 80 characters"]);
  assert.deepEqual(check(field("name"), one({ name: "   " })), ["can't be blank"]);
  assert.deepEqual(check(field("message"), one({ message: "" })), [], "optional");
  assert.deepEqual(check(field("message"), one({ message: "x".repeat(10001) })), ["is longer than 10000 characters"]);
  assert.deepEqual(check(field("consent"), one({})), ["must be ticked"]);
  assert.deepEqual(check(field("email"), one({ email: " jane@example.test " })), []);
  assert.deepEqual(check(field("email"), one({ email: "jane@example" })), ["isn't an email address"]);
  assert.deepEqual(check(field("phone"), one({ phone: "12-34" })), ["isn't a phone number"]);
  assert.deepEqual(check(field("phone"), one({ phone: "+1 (555) 010-9999" })), []);
  assert.deepEqual(check(field("website"), one({ website: "https://acme.test/x" })), []);
  assert.deepEqual(check(field("website"), one({ website: "https://acme.test/%zz" })), ["isn't a web address (https://…)"], "the pattern passes it; Go's url.Parse doesn't");
  assert.deepEqual(check(field("guests"), one({ guests: "abc" })), ["isn't a number"]);
  assert.deepEqual(check(field("guests"), one({ guests: "1e400" })), ["isn't a number"], "overflows a float64");
  assert.deepEqual(check(field("guests"), one({ guests: "0" })), ["is at least 1"]);
  assert.deepEqual(check(field("guests"), one({ guests: "13" })), ["is at most 12"]);
  assert.deepEqual(check(field("guests"), one({ guests: "4" })), []);
  assert.deepEqual(check(field("date"), one({ date: "2026-1-1" })), ["isn't a date"]);
  assert.deepEqual(check(field("date"), one({ date: "2026-02-30" })), ["isn't a date"], "a real calendar date");
  assert.deepEqual(check(field("date"), one({ date: "2026-13-01" })), ["isn't a date"]);
  assert.deepEqual(check(field("date"), one({ date: "2028-02-29" })), []);
  assert.deepEqual(check(field("topic"), one({ topic: "Sales" })), []);
  assert.deepEqual(check(field("contact_by"), one({ contact_by: "Fax" })), ["isn't one of the choices"]);
  assert.deepEqual(check(field("interests"), one({ interests: ["News", "Spam"] })), ["Spam isn't one of the choices"]);
  assert.deepEqual(check(field("interests"), one({ interests: ["News", "Events"] })), []);
  assert.deepEqual(check(field("source"), one({})), [], "a hidden field that isn't required");
});

test("each field's rules are the keys that apply to its type, and only those", () => {
  const keys = (name) => Object.keys(field(name).rules).sort();
  assert.deepEqual(keys("name"), ["max_length", "required"]);
  assert.deepEqual(keys("guests"), ["max", "max_length", "min", "pattern", "required"]);
  assert.deepEqual(keys("topic"), ["max_length", "options", "required"]);
  assert.deepEqual(keys("brief"), ["accept", "max_mb", "required"]);
  for (const type of ["email", "tel", "url", "date", "number"]) {
    const f = fields.find((each) => each.type === type);
    assert.equal(typeof f.rules.pattern, "string", type);
    assert.doesNotThrow(() => new RegExp(f.rules.pattern, "v"), `${type}: the pattern reads as an <input pattern> (v flag)`);
  }
});

test("files: size and type, by the field's rules", () => {
  const brief = field("brief");
  const files = (file) => ({ values: {}, files: { brief: [file] } });
  assert.deepEqual(check(brief, files({ name: "a.pdf", type: "application/pdf", size: 1000 })), []);
  assert.deepEqual(check(brief, files({ name: "a.png", type: "image/png", size: 1000 })), []);
  assert.deepEqual(check(brief, files({ name: "a.exe", type: "application/octet-stream", size: 10 })), [`isn't an allowed type (${brief.rules.accept.join(", ")})`]);
  assert.deepEqual(check(brief, files({ name: "a.pdf", type: "application/pdf", size: 3 * 1024 * 1024 })), [`is larger than ${brief.rules.max_mb} MB`]);
  assert.deepEqual(check(brief, { values: {} }), []);
});

test("the validator reads a FormData's entries, x[] as x", () => {
  const data = new FormData();
  data.append("services[]", "Design");
  data.append("services[]", "Build");
  data.append("brief", new Blob(["%PDF"], { type: "application/pdf" }), "brief.pdf");
  const posted = postedFrom(data);
  assert.deepEqual(posted.values.services, ["Design", "Build"]);
  assert.equal(posted.files.brief[0].name, "brief.pdf");
  assert.equal(sentence("Email", "isn't an email address"), "Email isn't an email address.");
});

test("the validator is generic: no form's names or types in its code", async () => {
  const source = await readFile(new URL("../dist/forms/rules.js", import.meta.url), "utf8");
  // (Words the validator's own data has — a file's name, type and size — aren't a form's.)
  const own = new Set(["name", "type", "size", "label", "values", "files"]);
  for (const f of form.fields.filter((f) => f.name && !own.has(f.name))) assert.doesNotMatch(source, new RegExp(`["']${f.name}["']`), f.name);
});

test("FIELD_TYPES is the Forms plugin's palette", async () => {
  const palette = await readFile(new URL("../librepublishgo/plugins/forms/manifest.go", import.meta.url), "utf8");
  const goTypes = [...palette.matchAll(/\{"type": "([a-z]+)", "label"/g)].map((m) => m[1]);
  assert.ok(goTypes.length > 5, "read the palette from plugins/forms/manifest.go");
  assert.deepEqual([...goTypes].sort(), [...FIELD_TYPES].sort());
});

test("the Forms plugin's list and answers have the shapes <Form> and the lock read", () => {
  const list = fixture("forms", "form-list");
  for (const item of list.forms) assert.deepEqual(Object.keys(item).sort(), ["digest", "name", "open", "slug"]);
  const ok = fixture("forms", "form-submit-200");
  assert.equal(ok.ok, true);
  assert.equal(typeof ok.message, "string");
  assert.equal(typeof ok.redirect, "string");
  const closed = fixture("forms", "form-submit-410");
  assert.equal(contractIndex()["forms/form-submit-410.json"].status, 410);
  assert.equal(closed.error, "closed");
  assert.equal(list.forms.find((item) => item.slug === "newsletter")?.open, false, "the closed form is listed as closed");
  assert.equal(typeof form.digest, "string");
  assert.equal(typeof form.spam.min_seconds, "number");
  assert.ok("honeypot_field" in form.spam && "timestamp_field" in form.spam && "captcha" in form.spam);
});

test("a field shown only for some answers is checked only when they're given (show_if)", () => {
  const conditional = form.fields.find((f) => f.show_if);
  assert.ok(conditional, "the contract's definition has a field with show_if");
  assert.deepEqual(field(conditional.name).show_if, conditional.show_if, "clientRules carries it");
  const { field: controller, values } = conditional.show_if;
  // The submission the server took left it out, its condition unmet; it's required when it's met.
  assert.deepEqual(validate(fields, postedBody("form-submit-200")), {});
  const met = postedBody("form-submit-200");
  met.values[controller] = [values[0]];
  assert.deepEqual(validate(fields, met)[conditional.name], ["can't be blank"]);
  assert.equal(shown(fields, met).has(conditional.name), true);
  assert.equal(shown(fields, postedBody("form-submit-200")).has(conditional.name), false);
});

test("shown: a condition naming a hidden field hides its field too, as the CMS has it", () => {
  const chain = [
    { name: "service", type: "radio" },
    { name: "in_state", type: "checkbox", show_if: { field: "service", values: ["Move"] } },
    { name: "note", type: "text", show_if: { field: "in_state", values: ["yes"] } },
  ];
  assert.deepEqual([...shown(chain, one({ service: "Move", in_state: "yes" }))], ["service", "in_state", "note"]);
  assert.deepEqual([...shown(chain, one({ service: "Keep", in_state: "yes" }))], ["service"]);
  assert.deepEqual([...shown(chain, one({ service: " Move " }))], ["service", "in_state"]);
});

/** The contract's hook post: its body and headers, signed as the CMS signs it ("contract-secret"). */
function hookPost(secret = "contract-secret", body = JSON.stringify(fixture("forms", "form-hook-request"))) {
  const headers = contractIndex()["forms/form-hook-request.json"].headers;
  const signature = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  return { request: new Request("https://acme.example/api/hook", { method: "POST", body, headers: { "Content-Type": headers["Content-Type"], "X-CMS-Form": headers["X-CMS-Form"], [Object.keys(headers).find((h) => /signature/i.test(h))]: signature } }) };
}

test("formHook: the contract's post reaches the handler; its answer is the CMS's to read", async () => {
  const recorded = fixture("forms", "form-hook-request");
  let seen;
  const route = formHook((submission) => {
    seen = submission;
    return { redirect: `/quote?q=Q-1&zip=${answer(submission, "to_zip")}`, values: { quote_id: "Q-1" } };
  }, { secret: "contract-secret" });
  const res = await route(hookPost());
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { redirect: "/quote?q=Q-1&zip=32207", values: { quote_id: "Q-1" } });
  assert.deepEqual(seen, recorded);
  assert.equal(seen.event, "submission.created");
  // What the CMS answered the visitor with that redirect.
  assert.equal(fixture("forms", "form-submit-hook-200").redirect, "/quote?q=Q-1");
});

test("formHook: a refusal is a 422 with errors by field; a bad signature, another form or a throw aren't answers", async () => {
  const refuse = formHook(() => { throw new FormHookRefusal("We don't serve that zip yet.", { to_zip: ["isn't in our service area"] }); }, { secret: "contract-secret" });
  const refused = await refuse(hookPost());
  assert.equal(refused.status, 422);
  assert.deepEqual(await refused.json(), { message: "We don't serve that zip yet.", errors: { to_zip: ["isn't in our service area"] } });

  let ran = false;
  const route = formHook(() => { ran = true; }, { secret: "contract-secret", forms: ["contact"] });
  assert.equal((await route(hookPost("wrong-secret"))).status, 401);
  assert.equal((await route(hookPost("contract-secret", "{}"))).status, 400);
  assert.equal((await route(hookPost())).status, 404, "a hook for another form");
  assert.equal(ran, false);

  const broken = formHook(() => { throw new Error("gofuse is down"); }, { secret: "contract-secret" });
  const original = console.error;
  console.error = () => {};
  try {
    assert.equal((await broken(hookPost())).status, 500);
  } finally {
    console.error = original;
  }
  assert.deepEqual(await (await formHook(() => undefined, { secret: "contract-secret" })(hookPost())).json(), {});
});

test("formHook: steps go back with every answer; hook.test says it's a test", async () => {
  const steps = (zip) => formHook((submission, _context, hook) => {
    hook.step("Zip check", zip ? "ok" : "failed", zip || "not served");
    if (!zip) throw new FormHookRefusal("No.", { zip: ["isn't served"] });
    if (hook.test) {
      hook.step("Quote", "skipped", "a test");
      return { steps: [{ label: "Extra", status: "info" }] };
    }
    return { redirect: "/q" };
  }, { secret: "contract-secret" });
  const ok = await (await steps("32207")(hookPost())).json();
  assert.deepEqual(ok, { redirect: "/q", steps: [{ label: "Zip check", status: "ok", detail: "32207" }] });
  const refused = await steps("")(hookPost());
  assert.equal(refused.status, 422);
  assert.deepEqual((await refused.json()).steps, [{ label: "Zip check", status: "failed", detail: "not served" }]);

  const testBody = JSON.stringify({ ...fixture("forms", "form-hook-request"), test: true });
  const tested = await (await steps("32207")(hookPost("contract-secret", testBody))).json();
  assert.deepEqual(tested.steps.map((s) => s.label), ["Zip check", "Quote", "Extra"]);

  // A throw says how far it got.
  const original = console.error;
  console.error = () => {};
  try {
    const broken = formHook((_s, _c, hook) => { hook.step("Zip check", "ok"); throw new Error("gofuse is down"); }, { secret: "contract-secret" });
    const res = await broken(hookPost());
    assert.equal(res.status, 500);
    assert.deepEqual((await res.json()).steps, [{ label: "Zip check", status: "ok" }, { label: "Hook", status: "failed", detail: "gofuse is down" }]);
  } finally {
    console.error = original;
  }
  // No steps, no key: the answer is as it was.
  assert.deepEqual(await (await formHook(() => ({ redirect: "/x" }), { secret: "contract-secret" })(hookPost())).json(), { redirect: "/x" });
});
