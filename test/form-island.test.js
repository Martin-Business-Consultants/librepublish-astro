// <FormIsland> in a browser (jsdom), compiled as a site's build compiles it,
// on the contract's form definition and the CMS's recorded answers to a post
// (contracts/forms/form-submit-*): what it draws, which fields its
// conditions show, the rules it checks before posting, the JSON it posts,
// and each answer beside its field.
import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { JSDOM, VirtualConsole } from "jsdom";
import { compile } from "svelte/compiler";
import { MESSAGES, defaultValues, jsonBody, outcome } from "../dist/forms/browser.js";
import { FIELD_TYPES } from "../dist/forms/types.js";
import { fixture } from "./helpers.js";

const { form: definition } = fixture("forms", "form-definition");
const CMS = "https://cms.acme.example";
const source = new URL("../src/components/FormIsland.svelte", import.meta.url);
// Svelte's runtime for the browser: what "svelte" resolves to under a bundler's "browser" condition.
const svelteClient = pathToFileURL(fileURLToPath(new URL("../node_modules/svelte/src/index-client.js", import.meta.url))).href;

let dom;
let svelte;
let FormIsland;
let navigations = [];
const scratch = mkdtempSync(join(tmpdir(), "form-island-"));

before(async () => {
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (error) => { if (/navigation/i.test(error.message)) navigations.push(error.message); else console.error(error); });
  dom = new JSDOM("<!doctype html><html><head></head><body></body></html>", { url: "https://acme.example/contact", virtualConsole, pretendToBeVisual: true });
  const { window } = dom;
  for (const key of Object.getOwnPropertyNames(window)) {
    if (key in globalThis && !["Event", "CustomEvent", "EventTarget", "FormData", "File", "Blob", "navigator", "location"].includes(key)) continue;
    if (/^[A-Z]|^(window|document|navigator|location|getComputedStyle|requestAnimationFrame|cancelAnimationFrame)$/.test(key)) {
      Object.defineProperty(globalThis, key, { value: window[key], configurable: true, writable: true });
    }
  }
  // jsdom has no CSS.escape; a browser does.
  globalThis.CSS = window.CSS = { escape: (value) => String(value).replace(/["\\]/g, "\\$&") };

  // The component as a site's build compiles it for the browser, its imports pointed at this checkout.
  const { js } = compile(readFileSync(source, "utf8"), { generate: "client", filename: "FormIsland.svelte" });
  const code = js.code.replace(/(from|import)\s+["']([^"']+)["']/g, (_, keyword, specifier) => `${keyword} ${JSON.stringify(specifier === "svelte" ? svelteClient : import.meta.resolve(specifier))}`);
  const file = join(scratch, "FormIsland.js");
  writeFileSync(file, code);
  FormIsland = (await import(pathToFileURL(file).href)).default;
  svelte = await import(svelteClient);
});

after(() => rmSync(scratch, { recursive: true, force: true }));

let posts;
let mounted;
beforeEach(() => {
  posts = [];
  navigations = [];
  if (mounted) svelte.unmount(mounted);
  mounted = null;
  document.body.innerHTML = "";
});

/** The CMS: the definition, and `answer` (status and body) to a post. */
function cms({ form = definition, answer = { status: 200, body: fixture("forms", "form-submit-200") }, down = false } = {}) {
  globalThis.fetch = async (url, init = {}) => {
    if (down) throw new TypeError("Failed to fetch");
    const { pathname, search } = new URL(url);
    if (pathname === "/api/x/forms/definition") {
      assert.equal(`${pathname}${search}`, `/api/x/forms/definition?form=${form.slug}`);
      return Response.json({ form });
    }
    assert.equal(String(url), form.action, "posts to the definition's action");
    posts.push({ headers: init.headers, body: JSON.parse(init.body) });
    if (answer === "network") throw new TypeError("Failed to fetch");
    return Response.json(answer.body, { status: answer.status });
  };
}

async function settle() {
  for (let i = 0; i < 10; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    svelte.flushSync();
  }
}

async function island(props = {}) {
  const target = document.createElement("div");
  document.body.append(target);
  mounted = svelte.mount(FormIsland, { target, props: { slug: definition.slug, cms: CMS, ...props } });
  svelte.flushSync();
  await settle();
  return target;
}

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const named = (name) => $$(`[name="${name}"]`);
function set(name, value) {
  for (const control of named(name)) {
    if (control.type === "checkbox" || control.type === "radio") control.checked = [].concat(value).includes(control.value);
    else control.value = value;
  }
  named(name)[0].dispatchEvent(new Event("input", { bubbles: true }));
  named(name)[0].dispatchEvent(new Event("change", { bubbles: true }));
  svelte.flushSync();
}
async function send() {
  $("form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  await settle();
}
const errorFor = (name) => $(`[data-error-for="${name}"]`);
function fillValid() {
  set("name", "Ada Lovelace");
  set("email", "ada@example.test");
  set("consent", "yes");
  set("interests", ["News", "Events"]);
}

test("draws every field type of the contract's definition, as <Form> draws it", async () => {
  cms();
  const target = await island();
  const form = target.querySelector("form");
  assert.ok(form, "a form, once the definition came");
  assert.equal(form.id, "cms-form-contact");
  assert.equal(form.dataset.state, "idle");
  assert.equal(form.getAttribute("action"), definition.action);
  assert.deepEqual([...new Set(definition.fields.map((field) => field.type))].sort(), [...FIELD_TYPES].sort());

  for (const field of definition.fields) {
    if (field.type === "heading") { assert.equal($("h3.cms-form__heading").textContent, field.text); continue; }
    const [first, ...rest] = named(field.name);
    assert.ok(first, `${field.name} is drawn`);
    if (field.type !== "hidden") {
      const wrapper = $(`[data-field="${field.name}"]`);
      assert.ok(wrapper.classList.contains("cms-form__field") && wrapper.classList.contains(`cms-form__field--${field.type}`), field.name);
      assert.ok(wrapper.classList.contains(field.width === "half" ? "cms-form__field--half" : "cms-form__field--full"), `${field.name}: width`);
      assert.ok(errorFor(field.name)?.hidden, `${field.name}: an error, hidden`);
    }
    switch (field.type) {
      case "hidden": assert.equal(first.type, "hidden"); assert.equal(first.value, field.default); break;
      case "textarea": assert.equal(first.tagName, "TEXTAREA"); assert.equal(first.rows, field.rows); assert.equal(first.maxLength, field.rules.max_length); break;
      case "select": assert.deepEqual([...first.options].map((o) => o.value), ["", ...field.options]); break;
      case "radio":
      case "checkboxes":
        assert.deepEqual([first, ...rest].map((c) => [c.type, c.value]), field.options.map((o) => [field.type === "radio" ? "radio" : "checkbox", o]));
        break;
      case "checkbox": assert.equal(first.type, "checkbox"); assert.match(first.closest("label").textContent, new RegExp(field.text)); break;
      case "file": assert.equal(first.type, "file"); assert.equal(first.accept, field.rules.accept.join(",")); break;
      default:
        assert.equal(first.type, field.type, field.name);
        if (field.type === "number") { assert.equal(first.min, String(field.rules.min)); assert.equal(first.max, String(field.rules.max)); }
        else if (field.type !== "date") assert.equal(first.maxLength, field.rules.max_length, `${field.name}: maxlength`);
        if (["email", "tel", "url"].includes(field.type)) assert.equal(first.pattern, field.rules.pattern);
    }
    if (field.type !== "hidden" && field.type !== "checkboxes" && !field.show_if) assert.equal(first.required, field.rules.required, `${field.name}: required`);
  }
  assert.equal(named("_hp")[0].value, "");
  assert.match(named("_ts")[0].value, /^\d{13}$/);
  assert.equal($(".cms-form__submit").textContent, definition.submit_label);
});

test("while the definition comes it says so; with the CMS unreachable it says so and draws no form", async () => {
  let release;
  globalThis.fetch = () => new Promise((resolve) => { release = () => resolve(Response.json({ form: definition })); });
  const target = await island();
  assert.equal(target.firstElementChild.dataset.state, "loading");
  assert.match(target.textContent, /Loading the form/);
  release();
  await settle();
  assert.equal($("form").dataset.state, "idle");

  svelte.unmount(mounted);
  document.body.innerHTML = "";
  cms({ down: true });
  const errors = [];
  const down = await island({ onerror: (detail) => errors.push(detail) });
  assert.equal(down.querySelector("form"), null, "no form");
  assert.equal(down.firstElementChild.dataset.state, "unavailable");
  assert.equal(down.querySelector(".cms-form__unavailable").textContent, MESSAGES.unavailable);
  assert.equal(errors[0].status, 0);
});

test("a field shown only for some answers is hidden and disabled until they're given; hidden, it isn't checked or posted", async () => {
  cms();
  await island();
  const wrapper = $('[data-field="call_time"]');
  assert.ok(wrapper.hidden && named("call_time")[0].disabled, "hidden, and disabled");

  set("contact_by", "Phone");
  assert.ok(!wrapper.hidden && !named("call_time")[0].disabled, "shown for its answer");
  fillValid();
  await send();
  assert.equal(posts.length, 0, "required while shown: not posted");
  assert.equal(errorFor("call_time").textContent, "Best time to call can't be blank.");

  set("contact_by", "Email");
  assert.ok(wrapper.hidden && named("call_time")[0].disabled, "hidden again");
  await send();
  assert.equal(posts.length, 1);
  assert.ok(!("call_time" in posts[0].body), "not posted");
});

test("the CMS's rules are checked before posting, in its words, beside each field", async () => {
  cms();
  const failures = [];
  await island({ onerror: (detail) => failures.push(detail) });
  set("email", "ada@example");
  set("guests", "13");
  await send();
  assert.equal(posts.length, 0, "nothing posted");
  assert.equal($("form").dataset.state, "failed");
  assert.equal($(".cms-form__status").textContent, MESSAGES.invalid);
  assert.equal(errorFor("name").textContent, "Name can't be blank.");
  assert.equal(errorFor("email").textContent, "Email isn't an email address.");
  assert.equal(errorFor("guests").textContent, "Guests is at most 12.");
  assert.equal(errorFor("consent").textContent, "Consent must be ticked.");
  assert.equal(errorFor("name").hidden, false);
  assert.equal(named("email")[0].getAttribute("aria-invalid"), "true");
  assert.deepEqual(Object.keys(failures[0].errors).sort(), ["consent", "email", "guests", "name"]);
});

test("posts JSON to the definition's action, with the spam fields, and shows the CMS's message", async () => {
  cms();
  const sent = [];
  await island({ onsubmitted: (detail) => sent.push(detail) });
  fillValid();
  set("guests", "4");
  await send();
  assert.equal(posts.length, 1);
  const [{ headers, body }] = posts;
  assert.equal(headers["Content-Type"], "application/json");
  assert.deepEqual(
    { ...body, _ts: undefined },
    { name: "Ada Lovelace", email: "ada@example.test", phone: "", message: "", guests: "4", topic: "", interests: ["News", "Events"], consent: "yes", date: "", website: "", source: "site", _hp: "", _ts: undefined },
  );
  assert.match(body._ts, /^\d{13}$/);
  assert.equal($("form").dataset.state, "sent");
  assert.equal($(".cms-form__status").textContent, fixture("forms", "form-submit-200").message);
  assert.equal(named("name")[0].value, "", "reset");
  assert.equal(sent[0].redirect, "");
  assert.equal(navigations.length, 0);
});

test("the CMS's 422 lands beside each field (form-submit-422)", async () => {
  const refused = fixture("forms", "form-submit-422");
  cms({ answer: { status: 422, body: refused } });
  await island();
  fillValid();
  await send();
  assert.equal(posts.length, 1);
  assert.equal($("form").dataset.state, "failed");
  assert.equal($(".cms-form__status").textContent, refused.message);
  const labels = Object.fromEntries(definition.fields.map((field) => [field.name, field.label]));
  for (const [name, messages] of Object.entries(refused.errors)) {
    const error = errorFor(name);
    assert.equal(error.hidden, false, name);
    assert.equal(error.textContent, `${labels[name]} ${messages[0]}.`.replace(/^./, (c) => c.toUpperCase()), name);
  }
});

test("a redirect in the answer sends the visitor there (form-submit-hook-200), unless the site keeps them", async () => {
  cms({ answer: { status: 200, body: fixture("forms", "form-submit-hook-200") } });
  const sent = [];
  await island({ onsubmitted: (detail) => sent.push(detail) });
  fillValid();
  await send();
  assert.equal(sent[0].redirect, "https://acme.example/quote?q=Q-1");
  assert.equal(navigations.length, 1, "went there (jsdom: navigation isn't implemented)");

  svelte.unmount(mounted);
  mounted = null;
  document.body.innerHTML = "";
  navigations = [];
  await island({ onsubmitted: () => false });
  fillValid();
  await send();
  assert.equal(navigations.length, 0, "onsubmitted said stay");
  assert.equal($("form").dataset.state, "sent");
});

test("closed (410), too many (429) and a post that never got there each say so", async () => {
  for (const [answer, message] of [
    [{ status: 410, body: fixture("forms", "form-submit-410") }, MESSAGES.closed],
    [{ status: 429, body: { error: "rate_limited" } }, MESSAGES.rateLimited],
    ["network", MESSAGES.network],
  ]) {
    cms({ answer });
    await island();
    fillValid();
    await send();
    assert.equal($("form").dataset.state, "failed");
    assert.equal($(".cms-form__status").textContent, message);
    svelte.unmount(mounted);
    mounted = null;
    document.body.innerHTML = "";
  }
  cms({ form: { ...definition, open: false } });
  await island();
  assert.equal($(".cms-form__closed").textContent, MESSAGES.closed);
  assert.equal(named("email").length, 0);
});

test("beforeSubmit and cms-form:before-submit add values, or stop the post with errors beside a field", async () => {
  cms();
  let zipOk = false;
  await island({
    beforeSubmit: (values) => {
      values.quote_ref = "Q-7";
      return zipOk ? undefined : { phone: ["isn't in our service area"] };
    },
  });
  const seen = [];
  $("form").addEventListener("cms-form:before-submit", (event) => {
    seen.push(event.detail.slug);
    event.detail.values.from_page = "yes";
    event.detail.waitUntil(Promise.resolve(true));
  });
  fillValid();
  await send();
  assert.equal(posts.length, 0, "stopped");
  assert.equal(errorFor("phone").textContent, "Phone isn't in our service area.");
  assert.equal($("form").dataset.state, "failed");

  zipOk = true;
  await send();
  assert.equal(posts.length, 1);
  assert.equal(posts[0].body.quote_ref, "Q-7");
  assert.equal(posts[0].body.from_page, "yes");
  assert.deepEqual(seen, ["contact", "contact"]);

  // preventDefault() stops it quietly.
  $("form").addEventListener("cms-form:before-submit", (event) => event.preventDefault());
  fillValid();
  await send();
  assert.equal(posts.length, 1);
  assert.equal($("form").dataset.state, "idle");
});

test("a field the site draws itself (a renderer, or an Astro slot field-<name>) sits in the island's wrapper, posts, and is disabled while hidden", async () => {
  cms();
  // What Astro hands a Svelte island for <div slot="field-call_time">: a raw snippet.
  const slot = svelte.createRawSnippet(() => ({ render: () => '<astro-slot name="field-call_time"><select name="call_time" class="mine"><option value="">When?</option><option>Mornings</option></select></astro-slot>' }));
  // From a site's Svelte component: a snippet, handed the field's context.
  const topic = svelte.createRawSnippet((context) => ({ render: () => `<div class="pills" id="${context().id}" data-required="${context().required}">${context().field.options.map((o) => `<label><input type="radio" name="topic" value="${o}"> ${o}</label>`).join("")}</div>` }));
  await island({ "field-call_time": slot, renderers: { topic }, classes: { submit: "btn btn--primary", field: "row" } });
  assert.equal($('[data-field="topic"] .pills').id, "cms-form-contact-topic");
  assert.equal(named("topic").length, 2);
  const wrapper = $('[data-field="call_time"]');
  assert.ok(wrapper.querySelector("select.mine"), "the site's markup");
  assert.ok(wrapper.querySelector('[data-error-for="call_time"]'), "the island's error beside it");
  assert.ok(wrapper.hidden && named("call_time")[0].disabled, "hidden and disabled by its show_if");
  assert.ok(["cms-form__submit", "btn", "btn--primary"].every((name) => $(".cms-form__submit").classList.contains(name)));
  assert.ok(wrapper.classList.contains("row"));

  set("contact_by", "Phone");
  assert.equal(named("call_time")[0].disabled, false);
  fillValid();
  set("call_time", "Mornings");
  set("topic", "Support");
  await send();
  assert.equal(posts[0].body.call_time, "Mornings");
  assert.equal(posts[0].body.topic, "Support");
});

test("jsonBody: a file as the CMS takes it in JSON, nothing for an empty file input; outcome reads each answer", async () => {
  const fields = [{ name: "brief", type: "file" }, { name: "interests", type: "checkboxes" }, { name: "hidden_one", type: "text" }];
  const body = await jsonBody(fields, [
    ["brief", new File(["%PDF-1"], "brief.pdf", { type: "application/pdf" })],
    ["interests", "News"],
    ["hidden_one", "x"],
    ["_hp", ""],
  ], new Set(["brief", "interests"]));
  assert.deepEqual(body, { brief: { filename: "brief.pdf", content_type: "application/pdf", data: Buffer.from("%PDF-1").toString("base64") }, interests: ["News"], _hp: "" });
  assert.deepEqual(await jsonBody(fields, [["brief", new File([], "")]], new Set(["brief"])), {});

  assert.deepEqual(outcome(200, fixture("forms", "form-submit-hook-200")), { ok: true, status: 200, message: "Thanks!", redirect: "/quote?q=Q-1" });
  assert.deepEqual(outcome(422, fixture("forms", "form-submit-422")).errors, fixture("forms", "form-submit-422").errors);
  assert.equal(outcome(410, fixture("forms", "form-submit-410")).message, MESSAGES.closed);
  assert.equal(outcome(500, "nope").message, MESSAGES.failed);
  assert.deepEqual(defaultValues(definition.fields), { source: ["site"] });
});
