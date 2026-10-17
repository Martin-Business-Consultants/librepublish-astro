/**
 * Live collections, for pages rendered on demand that should show a publish
 * at once (src/live.config.ts):
 *
 *   import { defineLiveCollection } from "astro:content";
 *   import { cmsLivePages, cmsLiveEntries } from "@librepublish/astro/live";
 *
 *   export const collections = {
 *     livePages: defineLiveCollection({ loader: cmsLivePages() }),
 *     livePosts: defineLiveCollection({ loader: cmsLiveEntries("posts") }),
 *   };
 *
 * What they answer is checked against the CMS's schema as it is when the
 * request comes in (read once, and again whenever the CMS's schema digest
 * changes), so a live page never renders a record the schema doesn't
 * describe: it gets an error instead. Entries are typed from the generated
 * "librepublish:types" (Page, Entries[collection]).
 *
 * Each answer carries the CMS's cache tags as its cacheHint. Hand it to
 * cacheHint() so the response says what it was built from (Cache-Tag) and a
 * publish purges it:
 *
 *   const { entry, cacheHint: hint } = await getLiveEntry("livePages", "about");
 *   cacheHint(Astro, hint);
 */
import type { LiveLoader } from "astro/loaders";
import type { Entries, Page } from "librepublish:types";
import { runtimeClient, warnIfSchemaMoved } from "./runtime/env.js";
import { CmsError, type CmsClient } from "./client.js";
import { buildSchemas, type CmsZod } from "./schema/zod.js";

type Hint = { tags?: string[]; lastModified?: Date };

const hint = (tags: Iterable<string>, updated?: string): Hint => ({
  tags: [...tags],
  lastModified: updated ? new Date(updated) : undefined,
});

/**
 * Adds a live collection result's cache tags to the response's Cache-Tag
 * (through the middleware the integration adds), and to Astro's route cache
 * when one is configured. Pass the result's `cacheHint`, an entry, or both.
 */
export function cacheHint(
  astro: { locals: object; cache?: { enabled?: boolean; set(hint: Hint): void } },
  ...hints: Array<Hint | { cacheHint?: Hint } | null | undefined>
): void {
  const tags = (astro.locals as { cmsTags?: Set<string> }).cmsTags;
  for (const given of hints) {
    const hint = given && "cacheHint" in given ? given.cacheHint : (given as Hint | null | undefined);
    if (!hint) continue;
    hint.tags?.forEach((tag) => tags?.add(tag));
    if (astro.cache?.enabled) astro.cache.set(hint);
  }
}

// The schema, kept per isolate and read again when the CMS's digest moves.
let current: { digest: string | undefined; zod: CmsZod } | null = null;
async function schemaFor(cms: CmsClient): Promise<CmsZod> {
  const digest = [...cms.digests].at(-1);
  if (current && (digest === undefined || current.digest === digest)) return current.zod;
  const answer = await cms.schema();
  const now = answer.meta?.schema_digest ?? digest;
  current = { digest: now, zod: buildSchemas(answer.data) };
  warnIfSchemaMoved(now);
  return current.zod;
}

async function checked<T>(cms: CmsClient, pick: (zod: CmsZod) => CmsZod["page"], record: unknown, what: string): Promise<T> {
  const zod = await schemaFor(cms);
  const parsed = pick(zod).safeParse(record);
  if (!parsed.success) {
    const issues = parsed.error.issues.slice(0, 5).map((issue) => `${issue.path.join(".") || "(record)"}: ${issue.message}`).join("; ");
    throw new Error(`CMS ${what} doesn't match the CMS's schema: ${issues}`);
  }
  return parsed.data as T;
}

// A missing entry is "not found" (undefined); anything else, a missing
// collection included, is an error the page can show.
async function attempt<T>(load: () => Promise<T>, missing: "empty" | "error" = "empty"): Promise<T | { error: Error }> {
  try {
    return await load();
  } catch (error) {
    if (missing === "empty" && error instanceof CmsError && error.status === 404) return undefined as T;
    return { error: error as Error };
  }
}

export function cmsLivePages(): LiveLoader<Page, { id: string }, { locale?: string }> {
  return {
    name: "librepublish-live-pages",
    loadCollection: ({ filter }) => attempt(async () => {
      const cms = runtimeClient();
      const { data } = await cms.pages({ locale: filter?.locale });
      const entries = [];
      for (const raw of data) {
        const page = await checked<Page>(cms, (zod) => zod.page, raw, `page "${raw.path}"`);
        entries.push({ id: page.path, data: page, cacheHint: hint([`page:${page.path}`], page.updated_at) });
      }
      return { entries, cacheHint: hint(cms.tags) };
    }, "error"),
    loadEntry: ({ filter }) => attempt(async () => {
      const cms = runtimeClient();
      const { data: raw } = await cms.page(filter.id);
      const page = await checked<Page>(cms, (zod) => zod.page, raw, `page "${raw.path}"`);
      return { id: page.path, data: page, cacheHint: hint(cms.tags, page.updated_at) };
    }),
  };
}

export function cmsLiveEntries<C extends keyof Entries & string>(
  collection: C,
): LiveLoader<Entries[C], { id: string }, { locale?: string }> {
  return {
    name: `librepublish-live-entries-${collection}`,
    loadCollection: ({ filter }) => attempt(async () => {
      const cms = runtimeClient();
      const { data } = await cms.entries(collection, { locale: filter?.locale });
      const entries = [];
      for (const raw of data) {
        const entry = await checked<Entries[C]>(cms, (zod) => zod.entry(collection), raw, `entry "${collection}/${raw.slug}"`);
        entries.push({ id: raw.slug, data: entry, cacheHint: hint([`entry:${collection}/${raw.slug}`], raw.updated_at) });
      }
      return { entries, cacheHint: hint(cms.tags) };
    }, "error"),
    loadEntry: ({ filter }) => attempt(async () => {
      const cms = runtimeClient();
      const { data: raw } = await cms.entry(collection, filter.id);
      const entry = await checked<Entries[C]>(cms, (zod) => zod.entry(collection), raw, `entry "${collection}/${raw.slug}"`);
      return { id: raw.slug, data: entry, cacheHint: hint(cms.tags, raw.updated_at) };
    }),
  };
}
