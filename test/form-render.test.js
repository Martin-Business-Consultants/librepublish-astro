// <Form> rendered for real (Astro's container, through Vite with Astro's
// plugins), from the contract's form definition: every field it has, each
// type drawn as that type.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { getViteConfig } from "astro/config";
import { experimental_AstroContainer } from "astro/container";
import { FIELD_TYPES } from "../dist/forms/types.js";
import { fixture } from "./helpers.js";

const { form } = fixture("forms", "form-definition");
let server;
let render;

before(async () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const secret = { type: "string", context: "server", access: "secret", optional: true };
  const config = await getViteConfig(
    { root, logLevel: "silent", appType: "custom", server: { middlewareMode: true, hmr: false, ws: false } },
    { root, logLevel: "silent", env: { schema: { CMS_BASE_URL: secret, CMS_API_TOKEN: secret } } },
  )({ mode: "test", command: "serve" });
  server = await createServer({ ...config, configFile: false });
  // The connection a build holds; the CMS answers the definition in hand.
  (await server.ssrLoadModule("/src/build-connection.ts")).keepConnection({ url: "https://cms.acme.example", token: "t" });
  const { default: Form } = await server.ssrLoadModule("/src/components/Form.astro");
  const container = await experimental_AstroContainer.create();
  render = async (definition, url = "https://acme.example/contact") => {
    globalThis.fetch = async () => new Response(JSON.stringify({ form: definition }), { headers: { "Content-Type": "application/json" } });
    return container.renderToString(Form, { props: { slug: definition.slug }, request: new Request(url), partial: true });
  };
});

after(() => server?.close());

/** The opening tag of the control posted as `name` (the first, for a group of choices). */
function controls(html, name) {
  return [...html.matchAll(/<(input|textarea|select)\b(?:[^>"]|"[^"]*")*>/g)]
    .map(([tag, element]) => ({ tag, element, attrs: attributes(tag) }))
    .filter((control) => control.attrs.name === name);
}
function attributes(tag) {
  return Object.fromEntries([...tag.matchAll(/\s([a-z-]+)(?:="([^"]*)")?/g)].map(([, key, value]) => [key, value === undefined ? true : value.replace(/&amp;/g, "&")]));
}

test("every field type of the contract's definition renders, as its type", { timeout: 60_000 }, async () => {
  const html = await render(form);
  const types = new Set(form.fields.map((field) => field.type));
  assert.deepEqual([...types].sort(), [...FIELD_TYPES].sort(), "the fixture has every field type the CMS's palette has");

  for (const field of form.fields) {
    if (field.type === "heading") {
      assert.match(html, new RegExp(`<h3 class="cms-form__heading"[^>]*>${field.text}</h3>`), "heading");
      continue;
    }
    const found = controls(html, field.name);
    assert.ok(found.length, `${field.name} (${field.type}) is drawn`);
    const [first] = found;
    const required = field.rules.required;
    switch (field.type) {
      case "hidden":
        assert.equal(first.attrs.type, "hidden");
        assert.equal(first.attrs.value, field.default ?? "");
        break;
      case "textarea":
        assert.equal(first.element, "textarea");
        assert.equal(first.attrs.rows, String(field.rows));
        assert.equal(first.attrs.maxlength, String(field.rules.max_length));
        break;
      case "select":
        assert.equal(first.element, "select");
        for (const option of field.options) assert.match(html, new RegExp(`<option value="${option}"`), `${field.name}: ${option}`);
        break;
      case "radio":
      case "checkboxes":
        assert.deepEqual(found.map((control) => control.attrs.value), field.options, `${field.name}: one ${field.type === "radio" ? "radio" : "checkbox"} per choice`);
        for (const control of found) assert.equal(control.attrs.type, field.type === "radio" ? "radio" : "checkbox");
        break;
      case "checkbox":
        assert.equal(first.attrs.type, "checkbox");
        assert.match(html, new RegExp(field.text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "the consent sentence");
        break;
      case "file":
        assert.equal(first.attrs.type, "file");
        assert.equal(first.attrs.accept, field.rules.accept.join(","));
        break;
      default:
        // text, email, tel, url, number, date: an <input> of the field's type.
        assert.equal(first.element, "input");
        assert.equal(first.attrs.type, field.type, field.name);
        if (field.type === "number") {
          assert.equal(first.attrs.min, String(field.rules.min));
          assert.equal(first.attrs.max, String(field.rules.max));
        } else if (field.type !== "date") {
          assert.equal(first.attrs.maxlength, String(field.rules.max_length), `${field.name}: maxlength`);
        }
        if (["email", "tel", "url"].includes(field.type)) assert.equal(first.attrs.pattern, field.rules.pattern, `${field.name}: the CMS's pattern`);
    }
    if (field.type !== "hidden" && field.type !== "checkboxes") assert.equal(Boolean(first.attrs.required), required, `${field.name}: required`);
    if (field.width === "half") assert.match(html, new RegExp(`cms-form__field--half"[^>]*data-field="${field.name}"`), `${field.name}: half width`);
  }

  // Spam checks, where a post without JavaScript comes back to, the rules for the script.
  assert.equal(controls(html, form.spam.honeypot_field)[0].attrs.value, "");
  assert.match(controls(html, form.spam.timestamp_field)[0].attrs.value, /^\d+$/);
  assert.equal(controls(html, "_return")[0].attrs.value, "https://acme.example/contact");
  assert.match(html, /enctype="multipart\/form-data"/);
  assert.ok(html.includes(`action="${form.action.replace(/&/g, "&amp;")}"`));
  const rules = JSON.parse(/<script type="application\/json" data-cms-form-rules[^>]*>([\s\S]*?)<\/script>/.exec(html)[1]);
  assert.deepEqual(rules.fields.map((field) => field.name), form.fields.filter((field) => field.type !== "heading").map((field) => field.name));
});

test("_return drops a previous answer's status; ?form_status shows it", async () => {
  const html = await render(form, "https://acme.example/contact?x=1&form=contact&form_status=sent");
  assert.equal(controls(html, "_return")[0].attrs.value, "https://acme.example/contact?x=1");
  assert.match(html, /data-state="sent"/);
  assert.match(html, new RegExp(form.success_message));
});

test("a closed form says so and draws no fields", async () => {
  const html = await render({ ...form, open: false });
  assert.match(html, /This form isn't taking submissions\./);
  assert.equal(controls(html, "email").length, 0);
});
