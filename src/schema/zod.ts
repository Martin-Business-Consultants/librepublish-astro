/**
 * The CMS's JSON Schema (GET /api/v1/schema) as Zod, so every record a
 * loader stores is checked against what the CMS says it holds:
 *
 *   - objects with `additionalProperties: false` are strict (an unknown key
 *     fails), others keep what they don't name, as JSON Schema means;
 *   - a required field must hold a value, as the CMS's own validator has it
 *     (internal/fields: not null, "" or []);
 *   - an optional one may be missing or null, or "" — which, for anything but
 *     text, reads as null;
 *   - `x-cms-type` adds what JSON Schema can't say: a link's shape, a safe
 *     URL, an RFC 3339 datetime, and `blocks` as a union discriminated by
 *     block type, each with its own data schema, nested as deep as the CMS
 *     nests them;
 *   - `oneOf` / `anyOf` is a union (SEO's `json_ld`: a node or a list).
 *
 * The records around the fields (a page, an entry, a global, an asset, a
 * block) are strict too, as the Go core writes them: a key it starts
 * sending that this package doesn't know fails the build rather than slip by.
 *
 * Types for the same shapes come from ./typegen.ts; the two are tested
 * against each other.
 */
import { z } from "astro/zod";
import type { CmsSchema, JsonSchema } from "../types.js";

type Zod = z.ZodType;

/** Field kinds whose "" is a value (text); for the rest "" means unset. */
const TEXT_KINDS = new Set(["string", "text", "markdown", "code"]);

const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/i;
const SAFE_SCHEMES = new Set(["http", "https", "mailto", "tel"]);

/** internal/fields SafeURL: http(s), mailto:, tel:, or a path — never javascript: and kin. */
export function safeURL(url: string): boolean {
  // eslint-disable-next-line no-control-regex
  const clean = url.replace(/[\u0000- \u007f]/g, "");
  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(clean)?.[1];
  return !scheme || SAFE_SCHEMES.has(scheme.toLowerCase());
}

export interface CmsZod {
  /** One block of any type the schema has, discriminated by `type`. */
  block: Zod;
  page: Zod;
  entry(collection: string): Zod;
  /** Any global, discriminated by `slug`. */
  global: Zod;
  asset: Zod;
  seo: Zod;
  /** Each block type's data schema, by slug. */
  blockData: Record<string, Zod>;
}

/** A richtext field: the admin editor's document (Tiptap JSON). The CMS checks its node and mark types on save. */
const attrValue = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const richTextNode: Zod = z.lazy(() => z.strictObject({
  type: z.string(),
  attrs: z.record(z.string(), attrValue).optional(),
  text: z.string().optional(),
  marks: z.array(z.strictObject({ type: z.string(), attrs: z.record(z.string(), attrValue).optional() })).optional(),
  content: z.array(richTextNode).optional(),
}));
export const richText = z.strictObject({ type: z.literal("doc"), content: z.array(richTextNode).optional() });

const nullToEmpty = (value: unknown) => (value === null || value === undefined ? {} : value);

export function buildSchemas(schema: CmsSchema): CmsZod {
  const blockData: Record<string, Zod> = {};
  let blockUnion: Zod = z.never();
  const block = z.lazy(() => blockUnion);
  const builder = new Builder(block);

  const slugs = Object.keys(schema.blocks ?? {}).sort();
  const members = slugs.map((slug) => {
    blockData[slug] = z.preprocess(nullToEmpty, builder.object(schema.blocks[slug], `blocks.${slug}`));
    return z.strictObject({
      id: z.string().optional(),
      type: z.literal(slug),
      version: z.number().int().optional(),
      data: blockData[slug],
      resolved: resolvedFor(slug),
    });
  });
  const known = new Set(slugs);
  const union = members.length === 0 ? z.never()
    : members.length === 1 ? members[0]
    : z.discriminatedUnion("type", members as unknown as [z.ZodObject, z.ZodObject, ...z.ZodObject[]]);
  // A block of a type the schema doesn't have gets a message that says so.
  blockUnion = z.unknown().superRefine((value, ctx) => {
    const type = (value as { type?: unknown } | null)?.type;
    if (typeof type !== "string" || !known.has(type)) {
      ctx.addIssue({
        code: "custom",
        path: ["type"],
        message: typeof type === "string"
          ? `block type "${type}" isn't in the CMS's schema (known: ${slugs.join(", ") || "none"})`
          : "a block needs a string `type`",
      });
    }
  }).pipe(union);

  const seo = z.preprocess(nullToEmpty, builder.object(schema.seo ?? { type: "object", properties: {} }, "seo"));
  const blocks = z.array(block);

  const record = {
    id: z.number().int(),
    slug: z.string(),
    title: z.string(),
    locale: z.string(),
    url: z.string(),
    seo,
    published_at: z.string().nullable(),
    updated_at: z.string(),
    category: term.nullable(),
    tags: z.array(term),
    translations: z.array(translation),
  };

  const pageFields: Record<string, Zod> = {};
  for (const [path, json] of Object.entries(schema.pages ?? {})) pageFields[path] = z.preprocess(nullToEmpty, builder.object(json, `pages.${path}`));
  const noFields = z.preprocess(nullToEmpty, z.strictObject({}));

  const page = z.strictObject({ ...record, path: z.string(), blocks, frontmatter: z.unknown() }).transform((value, ctx) => {
    const fields = pageFields[value.path] ?? noFields;
    const parsed = fields.safeParse(value.frontmatter);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) ctx.addIssue({ ...(issue as any), path: ["frontmatter", ...issue.path] });
      return z.NEVER;
    }
    return { ...value, frontmatter: parsed.data };
  });

  const entries = new Map<string, Zod>();
  const entry = (collection: string): Zod => {
    let found = entries.get(collection);
    if (found) return found;
    const json = schema.collections?.[collection];
    if (!json) {
      throw new Error(`The CMS's schema has no collection "${collection}" (it has: ${Object.keys(schema.collections ?? {}).join(", ") || "none"}). Is it "Available over the API"?`);
    }
    found = z.strictObject({
      ...record,
      collection: z.literal(collection),
      frontmatter: z.preprocess(nullToEmpty, builder.object(json, `collections.${collection}`)),
      body_markdown: z.string(),
      blocks: blocks.nullable(),
    });
    entries.set(collection, found);
    return found;
  };

  const globalMembers = Object.keys(schema.globals ?? {}).sort().map((slug) => z.strictObject({
    id: z.number().int(),
    slug: z.literal(slug),
    name: z.string(),
    data: z.preprocess(nullToEmpty, builder.object(schema.globals[slug], `globals.${slug}`)),
    updated_at: z.string(),
  }));
  const global = globalMembers.length === 0 ? z.never()
    : globalMembers.length === 1 ? globalMembers[0]
    : z.discriminatedUnion("slug", globalMembers as unknown as [z.ZodObject, z.ZodObject, ...z.ZodObject[]]);

  return { block, page, entry, global, asset, seo, blockData };
}

class Builder {
  constructor(private readonly block: Zod) {}

  /** An object schema: its properties, required ones, and strict when additionalProperties is false. */
  object(json: JsonSchema, at: string): z.ZodObject {
    const required = new Set(json.required ?? []);
    const shape: Record<string, Zod> = {};
    for (const [key, property] of Object.entries(json.properties ?? {})) {
      shape[key] = this.property(property, required.has(key), `${at}.${key}`);
    }
    return json.additionalProperties === false ? z.strictObject(shape) : z.looseObject(shape);
  }

  property(json: JsonSchema, required: boolean, at: string): Zod {
    const kind = json["x-cms-type"];
    const value = this.value(json, at);
    if (required) return nonEmpty(value);
    const keepsEmptyString = kind ? TEXT_KINDS.has(kind) : json.type === "string" && !json.enum && !json.format;
    const nullable = value.nullable();
    return (keepsEmptyString ? nullable : z.preprocess((v) => (v === "" ? null : v), nullable)).optional();
  }

  /** A value that's there: what type it is, whatever it's required to be. */
  value(json: JsonSchema, at: string): Zod {
    switch (json["x-cms-type"]) {
      case "blocks": return z.array(this.block);
      case "link": return link;
      case "richtext": return richText;
      case "url": return z.string().refine((url) => url.trim() !== "" && safeURL(url), { message: "must be a web address (http or https), mailto:, tel:, or a path" });
      case "datetime": return z.string().regex(RFC3339, { message: "must be an ISO 8601 datetime" });
    }
    // One of several shapes (a `json` field: one JSON-LD node or a list of them).
    const alternatives = json.oneOf ?? json.anyOf;
    if (Array.isArray(alternatives) && alternatives.length) {
      const members = alternatives.map((member, index) => this.value(member, `${at}<${index}>`));
      return members.length === 1 ? members[0] : z.union(members as unknown as [Zod, Zod, ...Zod[]]);
    }
    if (Array.isArray(json.enum)) {
      const values = json.enum;
      if (values.length > 0 && values.every((v) => typeof v === "string")) return z.enum(values as [string, ...string[]]);
      return values.length === 0 ? z.never() : z.union(values.map((v) => z.literal(v as any)) as any);
    }
    if (json.const !== undefined) return z.literal(json.const as any);
    switch (json.type) {
      case "string": return z.string();
      case "integer": return z.number().int();
      case "number": return z.number();
      case "boolean": return z.boolean();
      case "array": return z.array(json.items ? this.value(json.items, `${at}[]`) : z.unknown());
      case "object": return this.object(json, at);
    }
    throw new Error(`The CMS's schema at ${at} has a type this package can't read: ${JSON.stringify(json.type ?? json["x-cms-type"] ?? null)}.`);
  }
}

/**
 * Required: the CMS refuses null, "" and [] for a required field. null fails
 * every value schema already; "" and [] are refused here.
 */
function nonEmpty(value: Zod): Zod {
  if (value instanceof z.ZodString) return value.min(1, { message: "is required" });
  if (value instanceof z.ZodArray) return value.min(1, { message: "is required" });
  return value.refine((v) => v !== "", { message: "is required" });
}

const link = z.looseObject({
  kind: z.enum(["url", "page", "entry"]),
  value: z.string().min(1),
  collection: z.string().optional(),
}).superRefine((value, ctx) => {
  if (value.kind === "url" && !safeURL(value.value)) ctx.addIssue({ code: "custom", path: ["value"], message: "must be a web address (http or https), mailto:, tel:, or a path" });
  if (value.kind === "entry" && !value.collection?.trim()) ctx.addIssue({ code: "custom", path: ["collection"], message: "kind=entry requires a collection" });
});

const term = z.strictObject({ id: z.number().int(), slug: z.string(), title: z.string() });
const translation = z.strictObject({ locale: z.string(), path: z.string() });

const listedEntry = z.strictObject({
  id: z.number().int(),
  slug: z.string(),
  title: z.string(),
  status: z.string(),
  locale: z.string(),
  collection: z.string(),
  url: z.string(),
  frontmatter: z.record(z.string(), z.unknown()),
  seo: z.record(z.string(), z.unknown()),
  published_at: z.string().nullable(),
  updated_at: z.string(),
  category: term.nullable(),
  tags: z.array(term),
});

/** What the Go core resolves for a block (internal/cms/delivery.go, expandBlocks); nothing for other types. */
function resolvedFor(slug: string): Zod {
  if (slug === "collection_list") {
    return z.strictObject({
      collection: z.strictObject({ slug: z.string(), name: z.string() }).optional(),
      entries: z.array(listedEntry),
      total: z.number().int(),
      groups: z.array(z.strictObject({ key: z.string(), label: z.string(), entries: z.array(listedEntry) })).optional(),
      error: z.string().optional(),
      slug: z.string().optional(),
    }).optional();
  }
  if (slug === "contact_info") return z.strictObject({ contact: z.record(z.string(), z.string()) }).optional();
  return z.never().optional();
}

/** An asset as `included.assets` carries it (internal/cms/assets.go). */
export const asset = z.strictObject({
  id: z.number().int(),
  url: z.string(),
  original: z.string(),
  filename: z.string(),
  content_type: z.string(),
  byte_size: z.number().int(),
  width: z.number().int().nullable(),
  height: z.number().int().nullable(),
  alt: z.string(),
  folder: z.string(),
  variants: z.record(z.string(), z.string()).optional(),
  thumb_url: z.string().optional(),
  srcset: z.array(z.strictObject({ width: z.number().int(), descriptor: z.string(), url: z.string() })).optional(),
  focal_x: z.number().optional(),
  focal_y: z.number().optional(),
});
