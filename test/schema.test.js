import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { buildSchemas, asset, safeURL } from "../dist/schema/zod.js";
import { definitions, loaderTypes, moduleTypes } from "../dist/schema/typegen.js";
import { canonicalJson, digestOf, partDigests } from "../dist/schema/digest.js";
import { fixture } from "./helpers.js";

const schema = fixture("delivery", "schema");
const content = fixture("delivery", "content-full");
const zod = buildSchemas(schema.data);

const issues = (result) => result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);

test("every record the CMS delivered parses against the schema it published", () => {
  for (const page of content.data.pages) assert.ok(zod.page.safeParse(page).success, `page ${page.path}`);
  for (const entry of content.data.entries) assert.ok(zod.entry(entry.collection).safeParse(entry).success, `entry ${entry.collection}/${entry.slug}`);
  for (const global of content.data.globals) assert.ok(zod.global.safeParse(global).success, `global ${global.slug}`);
  for (const value of Object.values(content.included?.assets ?? {})) assert.ok(asset.safeParse(value).success, `asset ${value.id}`);
  for (const name of ["page-home", "page-about"]) assert.ok(zod.page.safeParse(fixture("delivery", name).data).success, name);
  for (const name of ["entries-posts", "entries-projects"]) {
    for (const entry of fixture("delivery", name).data) assert.ok(zod.entry(entry.collection).safeParse(entry).success, `${name} ${entry.slug}`);
  }
});

test("strict where the schema says additionalProperties: false — block data, frontmatter, SEO, repeater items, records", () => {
  const page = structuredClone(content.data.pages.find((p) => p.blocks.length));
  page.blocks[0].data.not_a_field = "x";
  page.seo.not_declared = "x";
  page.surprise = true;
  const found = issues(zod.page.safeParse(page));
  assert.ok(found.some((line) => line.startsWith("blocks.0.data") && /not_a_field/.test(line)), found.join("\n"));
  assert.ok(found.some((line) => line.startsWith("seo") && /not_declared/.test(line)), found.join("\n"));
  assert.ok(found.some((line) => /surprise/.test(line)), found.join("\n"));

  const post = structuredClone(content.data.entries.find((entry) => entry.slug === "first-post"));
  post.frontmatter.faqs[0].legacy = 1;
  post.frontmatter.author.legacy = 1;
  const strays = issues(zod.entry("posts").safeParse(post));
  assert.ok(strays.some((line) => line.startsWith("frontmatter.faqs.0") && /legacy/.test(line)), strays.join("\n"));
  assert.ok(strays.some((line) => line.startsWith("frontmatter.author") && /legacy/.test(line)), strays.join("\n"));
});

test("SEO declares json_ld (a node or a list of nodes) and exclude_from_sitemap", () => {
  assert.ok(schema.data.seo.properties.json_ld && schema.data.seo.properties.exclude_from_sitemap);
  const about = structuredClone(fixture("delivery", "page-about").data);
  assert.equal(about.seo.json_ld["@type"], "Organization");
  for (const json_ld of [{ "@type": "Thing" }, [{ "@type": "A" }, { "@type": "B" }], null]) {
    about.seo.json_ld = json_ld;
    assert.ok(zod.page.safeParse(about).success, JSON.stringify(json_ld));
  }
  for (const json_ld of ["{}", 3, ["x"]]) {
    about.seo.json_ld = json_ld;
    assert.ok(issues(zod.page.safeParse(about)).some((line) => line.startsWith("seo.json_ld")), JSON.stringify(json_ld));
  }
  about.seo = { exclude_from_sitemap: true };
  assert.ok(zod.page.safeParse(about).success);
  assert.match(definitions(schema.data), /"json_ld"\?: \(\{\n?[\s\S]*?\[key: string\]: unknown;[\s\S]*?\}\) \| \(Array<[\s\S]*?>\) \| null;/);
});

test("markdown fields are strings, marked as Markdown to render with <RichText>", () => {
  const bio = schema.data.collections.posts.properties.author.properties.bio;
  assert.equal(bio["x-cms-type"], "markdown");
  assert.equal(bio.contentMediaType, "text/markdown");
  const types = definitions(schema.data);
  assert.match(types, /\/\*\* Bio — CMS Markdown: render with <RichText> \*\/\n\s*"bio"\?: string \| null;/);
  assert.match(types, /\/\*\* CMS Markdown: render with <RichText> \*\/ body_markdown: string;/);
});

test("open where the schema doesn't close an object", () => {
  const object = buildSchemas({ blocks: { b: { type: "object", additionalProperties: false, properties: {
    items: { type: "array", "x-cms-type": "repeater", items: { type: "object", properties: { label: { type: "string", "x-cms-type": "string" } }, required: [] } },
  }, required: [] } }, collections: {}, globals: {}, pages: {}, seo: { type: "object", properties: {} } });
  const parsed = object.blockData.b.parse({ items: [{ label: "a", legacy: 1 }] });
  assert.deepEqual(parsed.items[0], { label: "a", legacy: 1 });
});

test("patterns are expanded: no `pattern` block type, and every delivered block is one the schema has", () => {
  assert.ok(!("pattern" in schema.data.blocks), "schema.blocks has no pattern");
  const known = new Set(Object.keys(schema.data.blocks));
  const seen = [];
  const walk = (blocks, depth = 0) => {
    for (const block of blocks ?? []) {
      seen.push(block.type);
      assert.ok(known.has(block.type), `block type ${block.type}`);
      for (const value of Object.values(block.data ?? {})) {
        if (Array.isArray(value) && value.every((item) => item && typeof item === "object" && "type" in item && "data" in item)) walk(value, depth + 1);
      }
    }
  };
  for (const name of ["content-full", "content-delta", "pages", "entries-posts", "entries-projects"]) {
    const data = fixture("delivery", name).data;
    for (const record of Array.isArray(data) ? data : [...data.pages, ...data.entries]) walk(record.blocks);
  }
  walk(fixture("delivery", "page-home").data.blocks);
  assert.ok(seen.includes("quote"), "the synced pattern on the home page arrives as its blocks");
});

test("blocks are a union discriminated by type, nested blocks included", () => {
  const about = structuredClone(fixture("delivery", "page-about").data);
  about.blocks.push({ id: "c1", type: "columns", data: { column_count: "2", items: [
    { type: "heading", data: { level: "2", text: "Inside" } },
    { type: "quote", data: { text: "Nested." } },
  ] } });
  const ok = zod.page.safeParse(about);
  assert.ok(ok.success, ok.success ? "" : issues(ok).join("\n"));

  const columns = about.blocks.at(-1);
  columns.data.items[0].data.level = "h9"; // heading.level is a select
  columns.data.items.push({ type: "made_up", data: {} });
  columns.data.items.push({ type: "pattern", data: { pattern_id: 1 } });
  const found = issues(zod.page.safeParse(about));
  assert.ok(found.some((line) => /data\.items\.0\.data\.level/.test(line)), found.join("\n"));
  assert.ok(found.some((line) => /items\.\d+\.type: block type "made_up" isn't in the CMS's schema/.test(line)), found.join("\n"));
  assert.ok(found.some((line) => /items\.\d+\.type: block type "pattern" isn't in the CMS's schema/.test(line)), found.join("\n"));
});

test("required means a value, as the CMS's validator has it; optional takes missing, null and \"\"", () => {
  const first = content.data.entries.find((entry) => entry.slug === "first-post");
  const posts = zod.entry("posts");
  const bare = structuredClone(first);
  bare.frontmatter = { summary: "Only this." };
  assert.ok(posts.safeParse(bare).success, "only the required field");
  assert.ok(posts.safeParse(content.data.entries.find((entry) => entry.slug === "second-post")).success, "an empty group as delivered");

  const nulls = structuredClone(first);
  Object.assign(nulls.frontmatter, { source: null, event_at: "", keywords: [], author: null, rating: null, cover: "" });
  const parsed = posts.safeParse(nulls);
  assert.ok(parsed.success, parsed.success ? "" : issues(parsed).join("\n"));
  assert.equal(parsed.data.frontmatter.event_at, null, "an empty datetime reads as null");

  for (const value of [undefined, null, ""]) {
    const missing = structuredClone(first);
    if (value === undefined) delete missing.frontmatter.summary; else missing.frontmatter.summary = value;
    assert.ok(!posts.safeParse(missing).success, `required text as ${JSON.stringify(value)}`);
  }
  const nested = structuredClone(first);
  nested.frontmatter.faqs = [{ answer: "No question." }];
  assert.ok(issues(posts.safeParse(nested)).some((line) => line.startsWith("frontmatter.faqs.0.question")));
});

test("x-cms-type adds what JSON Schema can't say: links, safe URLs, datetimes, integers, selects", () => {
  const first = content.data.entries.find((entry) => entry.slug === "first-post");
  const posts = zod.entry("posts");
  for (const [field, value] of [["source", "javascript:alert(1)"], ["event_at", "yesterday"], ["kind", "film"], ["rating", 4.5], ["keywords", "launch"], ["featured", "yes"]]) {
    const bad = structuredClone(first);
    bad.frontmatter[field] = value;
    assert.ok(!posts.safeParse(bad).success, `${field} = ${JSON.stringify(value)}`);
  }
  const ctaEntry = structuredClone(first);
  ctaEntry.frontmatter.cta = { kind: "entry", value: "alpha" };
  assert.ok(issues(posts.safeParse(ctaEntry)).some((line) => /cta\.collection/.test(line)));

  const nav = structuredClone(content.data.globals.find((global) => global.slug === "nav"));
  nav.data.links[0].url = { kind: "url", value: "javascript:void 0" };
  assert.ok(!zod.global.safeParse(nav).success);
  assert.equal(safeURL("/about"), true);
  assert.equal(safeURL("mailto:a@b.test"), true);
  assert.equal(safeURL(" java\tscript:x"), false);
});

test("a page's frontmatter follows its own path's fields; a page without fields has {}", () => {
  const about = structuredClone(fixture("delivery", "page-about").data);
  assert.ok(Object.keys(schema.data.pages).includes("about"));
  about.frontmatter.team_size = "twelve";
  about.frontmatter.tagline = "not declared";
  const found = issues(zod.page.safeParse(about));
  assert.ok(found.some((line) => line.startsWith("frontmatter.team_size")), found.join("\n"));
  assert.ok(found.some((line) => line.startsWith("frontmatter") && /tagline/.test(line)), found.join("\n"));

  const home = structuredClone(fixture("delivery", "page-home").data);
  assert.equal(home.path, "home");
  assert.deepEqual(home.frontmatter, {});
  home.frontmatter = { stray: 1 };
  assert.ok(issues(zod.page.safeParse(home)).some((line) => /frontmatter/.test(line)));
});

test("a collection the schema doesn't serve is a clear error", () => {
  assert.throws(() => zod.entry("nope"), /no collection "nope"/);
});

test("canonical JSON is Go's encoding/json", () => {
  assert.equal(canonicalJson({ b: [1, "<&>"], a: { d: true, c: null } }), '{"a":{"c":null,"d":true},"b":[1,"\\u003c\\u0026\\u003e"]}');
  assert.equal(canonicalJson("é\u2028\n\b\f\u0001\u007f"), '"é\\u2028\\n\\b\\f\\u0001\u007f"');
  assert.equal(canonicalJson({ 1e21: 1e21, small: 1e-7, f: 0.1 }), '{"1e+21":1e+21,"f":0.1,"small":1e-7}');
  assert.equal(canonicalJson({ "é": 1, "z": 2, "\uffff": 3, "\u{1f600}": 4 }), '{"z":2,"é":1,"\uffff":3,"\u{1f600}":4}', "keys by UTF-8 bytes");
  const parts = partDigests(schema.data);
  assert.ok(parts["blocks/hero"] && parts.seo && parts["collections/posts"] && parts["pages/about"]);
});

function compile(files) {
  const dir = mkdtempSync(join(tmpdir(), "lp-types-"));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  const program = ts.createProgram(Object.keys(files).map((name) => join(dir, name)), {
    strict: true, noEmit: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, skipLibCheck: true, types: [],
  });
  return ts.getPreEmitDiagnostics(program).map((d) => `${d.file ? d.file.fileName.split("/").pop() : ""}: ${ts.flattenDiagnosticMessageText(d.messageText, "\n")}`);
}

test("the generated TypeScript compiles: the module, and each loader's Entry", () => {
  const digest = digestOf(schema.data);
  assert.deepEqual(compile({ "cms.d.ts": moduleTypes(schema.data, digest), "use.ts": 'import type { Page, Block, Entries, Globals } from "librepublish:types";\nexport type X = [Page, Block, Entries, Globals];\n' }), []);
  for (const entry of ["Page", 'Entries["posts"]', 'Entries["projects"]', "Global", "Asset"]) {
    assert.deepEqual(compile({ "loader.ts": loaderTypes(schema.data, entry, digest) }), [], entry);
  }
});

test("BlockComponents needs a component for every block type, and only those", () => {
  const types = Object.keys(schema.data.blocks);
  const literal = (keys) => `{ ${keys.map((key) => `${JSON.stringify(key)}: C`).join(", ")} }`;
  const header = `${definitions(schema.data)}\ndeclare const C: (props: any) => any;\n`;
  assert.deepEqual(compile({ "ok.ts": `${header}export const all: BlockComponents = ${literal(types)};\n` }), []);

  const missing = compile({ "missing.ts": `${header}export const some: BlockComponents = ${literal(types.filter((type) => type !== "hero"))};\n` });
  assert.ok(missing.some((line) => /'hero' is missing/.test(line)), missing.join("\n"));

  const extra = compile({ "extra.ts": `${header}export const more: BlockComponents = ${literal([...types, "retired_block"])};\n` });
  assert.ok(extra.some((line) => /retired_block/.test(line)), extra.join("\n"));

  // A component's props are checked against the block's data.
  const wrong = compile({ "wrong.ts": `${header}declare const Hero: (props: { heading: number }) => any;\nexport const typed: BlockComponents = { ...(${literal(types)}), hero: Hero };\n` });
  assert.ok(wrong.some((line) => /heading/.test(line)), wrong.join("\n"));
});

test("generated field types follow the same rules as the Zod", () => {
  const text = definitions(schema.data);
  assert.match(text, /export type PostsFields = \{[\s\S]*?"kind"\?: "news" \| "guide" \| null;/);
  assert.match(text, /export type PostsFields = \{[\s\S]*?"summary": string;/);
  assert.match(text, /"event_at"\?: string \| null;/);
  assert.match(text, /"cover"\?: AssetId \| null;/);
  assert.match(text, /"keywords"\?: Array<string> \| null;/);
  assert.match(text, /"cta"\?: Link \| null;/);
  assert.match(text, /export type ProjectsFields = \{[\s\S]*?"client": string;[\s\S]*?"year"\?: number \| null;/);
  assert.match(text, /export interface PagesWithFields \{\n  "about": \{/);
  assert.match(text, /"items": Block\[\];/);
  assert.doesNotMatch(text, /"pattern": PatternBlock/);
});
