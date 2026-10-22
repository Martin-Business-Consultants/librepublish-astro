/**
 * Content collections from the CMS, for src/content.config.ts:
 *
 *   import { defineCollection } from "astro:content";
 *   import { cmsPages, cmsEntries, cmsGlobals, cmsAssets } from "@librepublish/astro/loaders";
 *
 *   export const collections = {
 *     pages: defineCollection({ loader: cmsPages() }),
 *     posts: defineCollection({ loader: cmsEntries("posts") }),
 *     globals: defineCollection({ loader: cmsGlobals() }),
 *     assets: defineCollection({ loader: cmsAssets() }),
 *   };
 *
 * Each loader gives Astro its schema (createSchema): Zod made from the CMS's
 * schema — the one cms.lock.json pins — and the TypeScript for its entries.
 * Every record goes through it (parseData), so content the schema doesn't
 * describe fails the build, naming the record and the field. Don't give these
 * collections a `schema` of your own: it would replace the CMS's.
 *
 * They read GET /api/v1/content once per build between them, and only what
 * changed since the last build (the cursor is kept in each collection's
 * meta) — unless the schema or the CMS changed since, when every record is
 * read and checked again. Ids: a page's path ("home" is the home page), an entry's slug, a
 * global's slug, an asset's id.
 */
import type { Loader, LoaderContext } from "astro/loaders";
import { buildClient, buildConnection, buildState, heldSchema, type LockedSchema } from "./build-connection.js";
import { buildSchemas, asset as assetSchema, type CmsZod } from "./schema/zod.js";
import { loaderTypes } from "./schema/typegen.js";
import type { CmsAsset, CmsContent, ContentMeta, Envelope } from "./types.js";

type Snapshot = Envelope<CmsContent, ContentMeta>;

// One request per cursor, shared by the collections reading in the same
// build, and forgotten soon after so `astro dev` sees new content.
const pending = new Map<string, Promise<Snapshot>>();
function snapshot(since: string | undefined): Promise<Snapshot> {
  const key = since ?? "";
  let request = pending.get(key);
  if (!request) {
    request = buildClient().content(since);
    pending.set(key, request);
    setTimeout(() => pending.delete(key), 5_000).unref?.();
  }
  return request;
}

/** The cursor of the newest snapshot read, for the build report. */
export let lastCursor: string | undefined;

/** The schema this build runs against: the one the integration checked against cms.lock.json. */
async function lockedSchema(): Promise<LockedSchema> {
  const held = heldSchema();
  if (held) return held;
  throw new Error("@librepublish/astro: the content loaders need cms() in astro.config's integrations (it reads the CMS's schema and checks it against cms.lock.json).");
}

const compiled = new Map<string, CmsZod>();
function zodFor(locked: LockedSchema): CmsZod {
  let found = compiled.get(locked.digest);
  if (!found) compiled.set(locked.digest, (found = buildSchemas(locked.schema)));
  return found;
}

/** Stop when an answer during the build carried a schema digest other than the locked one. */
function assertSameSchema(locked: LockedSchema) {
  const other = [...buildState().digests].find((digest) => digest !== locked.digest);
  if (other) {
    throw new Error(`The CMS's schema changed during the build (${other}, not ${locked.digest}). Build again; if it changed for good, run \`npx librepublish-astro sync\` first.`);
  }
}

interface Kind {
  name: string;
  /** The records this collection keeps from a snapshot, by id. */
  pick(content: CmsContent, included: Record<string, CmsAsset>): [string, Record<string, unknown>][];
  /** The ids a delta says stopped being live. */
  removed(content: CmsContent): string[];
  /** Its Zod schema and the TypeScript name of its entries. */
  schema(zod: CmsZod): { schema: CmsZod["page"]; entry: string };
}

function contentLoader(kind: Kind): Loader {
  return {
    name: kind.name,
    createSchema: async () => {
      const locked = await lockedSchema();
      const { schema, entry } = kind.schema(zodFor(locked));
      return { schema, types: loaderTypes(locked.schema, entry, locked.digest) };
    },
    async load({ store, meta, parseData, generateDigest, logger }: LoaderContext) {
      const locked = await lockedSchema();
      // Records kept from a build against another schema, or another CMS, are read again, all of them.
      const source = `${buildConnection().url} ${locked.digest}`;
      const since = meta.get("source") === source ? meta.get("cursor") : undefined;
      const answer = await snapshot(since);
      assertSameSchema(locked);
      if (answer.meta.full) store.clear();
      for (const id of kind.removed(answer.data)) store.delete(id);

      const records = kind.pick(answer.data, answer.included?.assets ?? {});
      for (const [id, record] of records) {
        const data = await parseData({ id, data: record });
        store.set({ id, data, digest: generateDigest(record) });
      }
      meta.set("cursor", answer.meta.cursor);
      meta.set("source", source);
      lastCursor = answer.meta.cursor;
      logger.info(`${answer.meta.full ? "loaded" : "updated"} ${records.length} from the CMS`);
    },
  } satisfies Loader;
}

/** Every live page; `locale` keeps one language. */
export function cmsPages(options: { locale?: string } = {}): Loader {
  return contentLoader({
    name: "librepublish-pages",
    pick: ({ pages }) => pages.filter((page) => !options.locale || page.locale === options.locale).map((page) => [page.path, page as any]),
    removed: ({ removed }) => (removed?.pages ?? []).map((page) => page.path),
    schema: (zod) => ({ schema: zod.page, entry: "Page" }),
  });
}

/** A collection's live entries; `locale` keeps one language. */
export function cmsEntries(collection: string, options: { locale?: string } = {}): Loader {
  return contentLoader({
    name: `librepublish-entries-${collection}`,
    pick: ({ entries }) => entries
      .filter((entry) => entry.collection === collection && (!options.locale || entry.locale === options.locale))
      .map((entry) => [entry.slug, entry as any]),
    removed: ({ removed }) => (removed?.entries ?? []).filter((entry) => entry.collection === collection).map((entry) => entry.slug),
    schema: (zod) => ({ schema: zod.entry(collection), entry: `Entries[${JSON.stringify(collection)}]` }),
  });
}

/** The globals (nav, footer…), by slug. */
export function cmsGlobals(): Loader {
  return contentLoader({
    name: "librepublish-globals",
    pick: ({ globals }) => globals.map((global) => [global.slug, global as any]),
    removed: ({ removed }) => (removed?.globals ?? []).map((global) => global.slug),
    schema: (zod) => ({ schema: zod.global, entry: "Global" }),
  });
}

/** The assets the content points at, by id: absolute URLs, size, alt, renditions. */
export function cmsAssets(): Loader {
  return contentLoader({
    name: "librepublish-assets",
    pick: (_content, assets) => Object.entries(assets).map(([id, value]) => [id, value as any]),
    removed: () => [],
    schema: () => ({ schema: assetSchema, entry: "Asset" }),
  });
}
