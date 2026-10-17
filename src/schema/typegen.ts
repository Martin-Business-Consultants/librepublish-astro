/**
 * TypeScript from the CMS's schema, the same shapes ./zod.ts checks:
 *
 *   - the "librepublish:types" module (.astro/integrations/librepublish/cms.d.ts):
 *       import type { Page, Entries, Globals, Block, BlockComponents } from "librepublish:types";
 *   - each content loader's `types` (createSchema), exporting its `Entry`.
 *
 * `BlockComponents` maps every block type to the component that renders it,
 * so a <Blocks components={…}> missing one is a type error (astro check).
 */
import type { CmsSchema, JsonSchema } from "../types.js";

/** The shared declarations, each `export`ed: fine at the top of a module and inside `declare module`. */
export function definitions(schema: CmsSchema): string {
  const taken = new Set<string>();
  // Slugs that read alike ("foo-bar", "foo_bar") still get names of their own.
  const name = (slug: string, suffix: string) => {
    let candidate = `${pascal(slug)}${suffix}`;
    for (let n = 2; taken.has(candidate); n++) candidate = `${pascal(slug)}${n}${suffix}`;
    taken.add(candidate);
    return candidate;
  };
  const out: string[] = [
    "/** An asset's id: look it up in `included.assets` (or the cmsAssets() collection). */",
    'export type AssetId = string & { readonly __cms: "AssetId" };',
    "/** An entry's slug, as a record_ref field holds it. */",
    'export type RecordRef = string & { readonly __cms: "RecordRef" };',
    "/** A link field: to a URL, a page by path, or an entry of a collection. */",
    'export type Link = { kind: "url" | "page" | "entry"; value: string; collection?: string; [key: string]: unknown };',
    "/** A node of a rich text document (the admin editor's Tiptap JSON). */",
    "export type RichTextNode = { type: string; attrs?: Record<string, string | number | boolean | null>; text?: string; marks?: Array<{ type: string; attrs?: Record<string, string | number | boolean | null> }>; content?: RichTextNode[] };",
    "/** A richtext field: render it with <RichText>. */",
    'export type RichText = { type: "doc"; content?: RichTextNode[] };',
    "export type Term = { id: number; slug: string; title: string };",
    "export type Translation = { locale: string; path: string };",
    "export type Asset = {",
    "  id: number; url: string; original: string; filename: string; content_type: string; byte_size: number;",
    "  width: number | null; height: number | null; alt: string; folder: string;",
    "  variants?: Record<string, string>; thumb_url?: string;",
    "  srcset?: { width: number; descriptor: string; url: string }[];",
    "  focal_x?: number; focal_y?: number;",
    "};",
    "/** Assets by id, as `included.assets` has them. */",
    "export type Assets = Record<string, Asset>;",
    "export type ListedEntry = {",
    "  id: number; slug: string; title: string; status: string; locale: string; collection: string; url: string;",
    "  frontmatter: Record<string, unknown>; seo: Record<string, unknown>;",
    "  published_at: string | null; updated_at: string; category: Term | null; tags: Term[];",
    "};",
    "export type CollectionListResolved = {",
    "  collection?: { slug: string; name: string }; entries: ListedEntry[]; total: number;",
    "  groups?: { key: string; label: string; entries: ListedEntry[] }[]; error?: string; slug?: string;",
    "};",
    "export type ContactInfoResolved = { contact: Record<string, string> };",
  ];

  const slugs = Object.keys(schema.blocks ?? {}).sort();
  const map: string[] = [];
  for (const slug of slugs) {
    const typeName = name(slug, "Block");
    map.push(`  ${JSON.stringify(slug)}: ${typeName};`);
    out.push(doc(schema.blocks[slug].title), `export type ${typeName} = ${object(schema.blocks[slug], 0)};`);
  }
  out.push(
    "/** Each block type's data, by type. */",
    `export interface CmsBlockMap {${map.length ? `\n${map.join("\n")}\n` : ""}}`,
    "export type BlockType = keyof CmsBlockMap;",
    'export type ResolvedFor<K> = K extends "collection_list" ? CollectionListResolved : K extends "contact_info" ? ContactInfoResolved : never;',
    "/** A block of type K: its data narrowed to that type's. */",
    "export type BlockOf<K extends BlockType> = { id?: string; type: K; version?: number; data: CmsBlockMap[K]; resolved?: ResolvedFor<K> };",
    "/** Any block. Narrow it on `block.type`. */",
    "export type Block = { [K in BlockType]: BlockOf<K> }[BlockType];",
    "/** What <Blocks> passes the component for a block of type K: its data, the block, what the CMS resolved, the assets. */",
    "export type BlockProps<K extends BlockType> = CmsBlockMap[K] & { block: BlockOf<K>; resolved: ResolvedFor<K> | undefined; assets: Assets };",
    "/** A component for every block type the CMS has: leave one out and it's a type error. */",
    "export type BlockComponents = { [K in BlockType]: (props: BlockProps<K>) => any };",
  );

  out.push(`export type Seo = ${object(schema.seo ?? { type: "object" }, 0)};`);
  out.push(
    "type RecordBase = {",
    "  id: number; slug: string; title: string; locale: string; url: string; seo: Seo;",
    "  published_at: string | null; updated_at: string; category: Term | null; tags: Term[]; translations: Translation[];",
    "};",
  );

  const pages = Object.keys(schema.pages ?? {}).sort();
  out.push(
    "/** Pages that carry fields of their own, by path: their frontmatter. */",
    `export interface PagesWithFields {${pages.length ? `\n${pages.map((path) => `  ${JSON.stringify(path)}: ${object(schema.pages[path], 1)};`).join("\n")}\n` : ""}}`,
    "export type PageBase = RecordBase & { path: string; blocks: Block[]; frontmatter: Record<string, never> };",
    "/** A live page; one with fields of its own has them typed by its path. */",
    pages.length
      ? "export type Page = { [P in keyof PagesWithFields]: Omit<PageBase, \"path\" | \"frontmatter\"> & { path: P; frontmatter: PagesWithFields[P] } }[keyof PagesWithFields] | PageBase;"
      : "export type Page = PageBase;",
  );

  const collections = Object.keys(schema.collections ?? {}).sort();
  const entries: string[] = [];
  for (const slug of collections) {
    const typeName = name(slug, "Fields");
    out.push(doc(schema.collections[slug].title), `export type ${typeName} = ${object(schema.collections[slug], 0)};`);
    entries.push(`  ${JSON.stringify(slug)}: RecordBase & { collection: ${JSON.stringify(slug)}; frontmatter: ${typeName}; /** ${RICH_TEXT_NOTE} */ body_markdown: string; blocks: Block[] | null };`);
  }
  out.push("/** Each collection's live entries' shape, by collection. */", `export interface Entries {${entries.length ? `\n${entries.join("\n")}\n` : ""}}`);

  const globals: string[] = [];
  for (const slug of Object.keys(schema.globals ?? {}).sort()) {
    const typeName = name(slug, "Global");
    out.push(doc(schema.globals[slug].title), `export type ${typeName} = ${object(schema.globals[slug], 0)};`);
    globals.push(`  ${JSON.stringify(slug)}: { id: number; slug: ${JSON.stringify(slug)}; name: string; data: ${typeName}; updated_at: string };`);
  }
  out.push(
    "/** Each global, by slug. */",
    `export interface Globals {${globals.length ? `\n${globals.join("\n")}\n` : ""}}`,
    "export type Global = Globals[keyof Globals];",
  );
  return out.join("\n");
}

/** The "librepublish:types" module, and App.Locals for pages rendered on demand. */
export function moduleTypes(schema: CmsSchema, digest: string): string {
  return [
    "// Generated by @librepublish/astro from the CMS's schema. Don't edit: it's rewritten on every build and sync.",
    `// Schema digest: ${digest}`,
    'declare module "librepublish:types" {',
    `  export const SCHEMA_DIGEST: ${JSON.stringify(digest)};`,
    indent(definitions(schema), "  "),
    "}",
    "",
    "declare namespace App {",
    "  interface Locals {",
    "    /** A CMS client for this request, on pages rendered on demand (its answers' cache tags become Cache-Tag). */",
    '    cms: import("@librepublish/astro/client").CmsClient;',
    "    /** The cache tags this response will carry. */",
    "    cmsTags: Set<string>;",
    "  }",
    "}",
    "",
  ].join("\n");
}

/** A content loader's `types`: the definitions and its `Entry`. */
export function loaderTypes(schema: CmsSchema, entry: string, digest: string): string {
  return [
    "// Generated by @librepublish/astro from the CMS's schema. Don't edit.",
    `// Schema digest: ${digest}`,
    definitions(schema),
    `export type Entry = ${entry};`,
    "",
  ].join("\n");
}

function property(json: JsonSchema, required: boolean, depth: number): string {
  const value = type(json, depth);
  return required ? value : `${value} | null`;
}

function type(json: JsonSchema, depth: number): string {
  switch (json["x-cms-type"]) {
    case "blocks": return "Block[]";
    case "link": return "Link";
    case "richtext": return "RichText";
    case "asset": return "AssetId";
    case "record_ref": return "RecordRef";
    case "record_refs": return "RecordRef[]";
    case "url":
    case "datetime": return "string";
  }
  const alternatives = json.oneOf ?? json.anyOf;
  if (Array.isArray(alternatives) && alternatives.length) return alternatives.map((member) => `(${type(member, depth)})`).join(" | ");
  if (Array.isArray(json.enum)) return json.enum.map((value) => JSON.stringify(value)).join(" | ") || "never";
  if (json.const !== undefined) return JSON.stringify(json.const);
  switch (json.type) {
    case "string": return "string";
    case "integer":
    case "number": return "number";
    case "boolean": return "boolean";
    case "array": return `Array<${json.items ? type(json.items, depth) : "unknown"}>`;
    case "object": return object(json, depth);
  }
  return "unknown";
}

function object(json: JsonSchema, depth: number): string {
  const pad = "  ".repeat(depth + 1);
  const required = new Set(json.required ?? []);
  const lines = Object.entries(json.properties ?? {}).map(([key, property_]) => {
    const optional = !required.has(key);
    const notes = [property_.title, property_.description, property_["x-cms-type"] === "markdown" ? RICH_TEXT_NOTE : property_["x-cms-type"] === "richtext" ? "Rich text: render with <RichText>" : undefined].filter(Boolean);
    const comment = notes.length ? `${pad}/** ${notes.join(" — ").replace(/\*\//g, "*\\/")} */\n` : "";
    return `${comment}${pad}${JSON.stringify(key)}${optional ? "?" : ""}: ${property(property_, !optional, depth + 1)};`;
  });
  if (json.additionalProperties !== false) lines.push(`${pad}[key: string]: unknown;`);
  return lines.length ? `{\n${lines.join("\n")}\n${"  ".repeat(depth)}}` : "Record<string, never>";
}

/** What a markdown field's type says about it. */
const RICH_TEXT_NOTE = "CMS Markdown: render with <RichText>";

function doc(title: unknown): string {
  return `/** ${String(title ?? "").replace(/\*\//g, "*\\/")} */`;
}

function indent(text: string, pad: string): string {
  return text.split("\n").map((line) => (line ? pad + line : line)).join("\n");
}

export function pascal(slug: string): string {
  return slug.split(/[^a-zA-Z0-9]+/).filter(Boolean).map((part) => part[0].toUpperCase() + part.slice(1)).join("") || "Unnamed";
}
