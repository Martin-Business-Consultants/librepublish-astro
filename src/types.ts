/**
 * What the Go core's delivery API (/api/v1) answers, as internal/cms/delivery.go
 * and delivery_shape.go build it. Every answer is `{ data, meta, included? }`;
 * `included.assets` holds the assets the records point at, by id.
 *
 * These are the open, structural shapes. The fields a site defines (block
 * data, frontmatter, global data) are typed exactly — and validated — from
 * the CMS's schema: see the generated "librepublish:types" module and the
 * content loaders (createSchema).
 */

export interface Envelope<T, M = Record<string, unknown>> {
  data: T;
  meta: M;
  included?: { assets?: Record<string, CmsAsset>; entries?: Record<string, CmsEntry>; pages?: Record<string, CmsPage> };
}

export interface ListMeta {
  page: number;
  per: number;
  total: number;
  next_page: number | null;
}

/** An asset as `included.assets` carries it (internal/cms/assets.go, delivery()). */
export interface CmsAsset {
  id: number;
  url: string;
  original: string;
  filename: string;
  content_type: string;
  byte_size: number;
  alt: string;
  width: number | null;
  height: number | null;
  /** The media library folder it's in, e.g. "/" or "/team". */
  folder: string;
  /** Images the CMS can resize: width-limited renditions by name ("w640" …), absolute URLs. Empty for SVGs. */
  variants?: Record<string, string>;
  /** Images only: the renditions for a srcset. */
  srcset?: { width: number; descriptor: string; url: string }[];
  thumb_url?: string;
  /** Images only: the focal point, 0–1 from the left and top. */
  focal_x?: number;
  focal_y?: number;
}

export interface CmsBlock<D = Record<string, unknown>> {
  /** Top-level blocks carry one; blocks nested in a `blocks` field may not. */
  id?: string;
  type: string;
  version?: number;
  data: D;
  /** What the CMS resolved for the block: a collection_list's entries, a contact_info's contact. */
  resolved?: CmsCollectionList | CmsContactInfo;
}

/** An entry as a collection_list block lists it. */
export interface CmsListedEntry<F = Record<string, unknown>> {
  id: number;
  slug: string;
  title: string;
  status: string;
  locale: string;
  collection: string;
  url: string;
  frontmatter: F;
  seo: Record<string, unknown>;
  published_at: string | null;
  updated_at: string;
  category: CmsTerm | null;
  tags: CmsTerm[];
}

/** A collection_list block's `resolved`. */
export interface CmsCollectionList {
  collection?: { slug: string; name: string };
  entries: CmsListedEntry[];
  total: number;
  groups?: { key: string; label: string; entries: CmsListedEntry[] }[];
  /** Set when the block names a collection that doesn't exist (with `slug`). */
  error?: string;
  slug?: string;
}

/** Settings › General's contact details. */
export interface CmsContact {
  title?: string;
  phone?: string;
  email?: string;
  address_line1?: string;
  city?: string;
  state?: string;
  zip?: string;
}

/** A contact_info block's `resolved`. */
export interface CmsContactInfo { contact: CmsContact }

export interface CmsTerm { id: number; slug: string; title: string }

export interface CmsTranslation { locale: string; path: string }

export interface CmsPage<F = Record<string, unknown>, S = Record<string, unknown>, B = CmsBlock> {
  id: number;
  path: string;
  slug: string;
  title: string;
  locale: string;
  /** Where it's served: site-relative ("/", "/about"), or an absolute SEO canonical. */
  url: string;
  blocks: B[];
  frontmatter: F;
  seo: S;
  published_at: string | null;
  updated_at: string;
  category: CmsTerm | null;
  tags: CmsTerm[];
  translations: CmsTranslation[];
}

export interface CmsEntry<F = Record<string, unknown>, S = Record<string, unknown>, B = CmsBlock> {
  id: number;
  slug: string;
  title: string;
  locale: string;
  collection: string;
  url: string;
  frontmatter: F;
  body_markdown: string;
  blocks: B[] | null;
  seo: S;
  published_at: string | null;
  updated_at: string;
  category: CmsTerm | null;
  tags: CmsTerm[];
  translations: CmsTranslation[];
}

export interface CmsGlobal<D = Record<string, unknown>> {
  id: number;
  slug: string;
  name: string;
  data: D;
  updated_at: string;
}

export interface CmsCollection {
  id: number;
  slug: string;
  name: string;
  enable_blocks: boolean;
  fields: unknown[];
}

export interface CmsSiteMeta {
  /** The CMS's own address (APP_URL), which asset URLs start with. */
  cms_url: string;
  /** The CMS build's version ("dev" for an unreleased build). */
  cms_version: string;
}

export interface CmsSite {
  name: string;
  /** The public site's URL (Settings › General); "" until it's set. */
  url: string;
  default_locale: string;
  /** Every locale but the default is a path prefix: /fr/… */
  locales: string[];
  contact: CmsContact;
  /** The enabled plugins' keys, e.g. "forms". */
  plugins: string[];
  /** What each enabled plugin tells a site (its manifest's site_config). */
  plugin_config: Record<string, Record<string, unknown>>;
  api_version: string;
  /** The widths the CMS renders image variants at (w<width>), ascending. */
  image_widths: number[];
  /** The visual identity (Settings › Brand): only what's set. Put it into CSS with brandingCss / <BrandStyles />. */
  branding: CmsBranding;
}

/** GET /api/v1/site's `branding`: each key only when it's set. */
export interface CmsBranding {
  logo?: CmsAsset;
  favicon?: CmsAsset;
  /** Hex, #rgb or #rrggbb. */
  primary_color?: string;
  /** Hex: the color the grays lean toward. */
  secondary_color?: string;
  /** A Google Fonts family. */
  font?: "Inter" | "DM Sans" | "Manrope" | "Playfair Display" | "Lora";
  border_radius?: "none" | "small" | "medium" | "large";
  box_shadow?: "none" | "small" | "medium" | "large";
}

export interface CmsContent {
  pages: CmsPage[];
  entries: CmsEntry[];
  globals: CmsGlobal[];
  /** Only on a delta (`?since=`): what stopped being live. */
  removed?: {
    pages: { id: number; path: string }[];
    entries: { id: number; collection: string; slug: string }[];
    globals: { id: number; slug: string }[];
  };
}

export interface ContentMeta { cursor: string; full: boolean; since: string }

export interface CmsRobots {
  text: string;
  mode: "generated" | "custom";
}

/** One URL of GET /api/v1/sitemap. `loc` is absolute once Settings › General has the site's URL. */
export interface CmsSitemapUrl {
  loc: string;
  path: string;
  lastmod: string;
  locale: string;
  type: "page" | "entry" | string;
  alternates: { hreflang: string; href: string }[];
}

export interface CmsRedirect { source: string; destination: string; status: number; wildcard: boolean }

/** One of GET /api/v1/site_health's checks. */
export interface CmsHealthCheck {
  key: string;
  state: "passes" | "fails" | "yours_to_judge";
  message: string;
}

/** A JSON Schema (2020-12) as the CMS writes it (internal/fields/fields.go). */
export interface JsonSchema {
  $schema?: string;
  type?: string | string[];
  title?: string;
  description?: string;
  enum?: unknown[];
  const?: unknown;
  format?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean | JsonSchema;
  items?: JsonSchema;
  oneOf?: JsonSchema[];
  anyOf?: JsonSchema[];
  "x-cms-type"?: string;
  [key: string]: unknown;
}

/** GET /api/v1/schema's `data`. */
export interface CmsSchema {
  $schema?: string;
  /** Each block type's data, by slug (with its label as `title`). */
  blocks: Record<string, JsonSchema>;
  /** Each served collection's frontmatter, by slug. */
  collections: Record<string, JsonSchema>;
  /** Each global's data, by slug. */
  globals: Record<string, JsonSchema>;
  /** Pages that carry fields of their own, by path. */
  pages: Record<string, JsonSchema>;
  seo: JsonSchema;
}

/** GET /api/v1/schema's `meta`: the schema's digest (docs/delivery-api.md) and the CMS's version. */
export interface CmsSchemaMeta { schema_digest: string; cms_version: string }
