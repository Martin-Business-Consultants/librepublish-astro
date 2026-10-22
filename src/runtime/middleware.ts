/**
 * For pages rendered on demand: `Astro.locals.cms` is a client for the
 * request, and the response says what content it was built from in a
 * Cache-Tag header (the CMS's tags: page:about, collection:posts, …), so a
 * publish purges exactly those pages (runtime/webhook.ts). Prerendered pages
 * are left alone.
 *
 * The tags come from every answer `Astro.locals.cms` gets, from each live
 * collection result a page hands to cacheHint() (@librepublish/astro/live),
 * and from Astro's own route cache when one is configured. The client is
 * made on first use, so a route that never reads the CMS (the purge webhook)
 * doesn't need the connection.
 *
 * When an answer carries a schema digest other than the one the site was
 * built against, the response says so (X-CMS-Schema-Stale) and the log once.
 */
import type { MiddlewareHandler } from "astro";
import { defineMiddleware } from "astro:middleware";
import type { CmsClient } from "../client.js";
import { runtimeClient, warnIfSchemaMoved } from "./env.js";

export const onRequest: MiddlewareHandler = defineMiddleware(async (context, next) => {
  if (context.isPrerendered) return next();

  const tags = new Set<string>();
  let client: CmsClient | undefined;
  Object.defineProperty(context.locals, "cms", {
    configurable: true,
    enumerable: true,
    get: () => (client ??= runtimeClient({ tags })),
  });
  Object.defineProperty(context.locals, "cmsTags", { configurable: true, enumerable: false, value: tags });

  const response = await next();
  const cache = (context as { cache?: { enabled?: boolean; tags?: string[] } }).cache;
  if (cache?.enabled) cache.tags?.forEach((tag) => tags.add(tag));
  try {
    if (tags.size > 0 && !response.headers.has("Cache-Tag")) response.headers.set("Cache-Tag", [...tags].join(","));
    const stale = client ? [...client.digests].find((digest) => warnIfSchemaMoved(digest)) : undefined;
    if (stale) response.headers.set("X-CMS-Schema-Stale", stale);
  } catch {
    // A response with immutable headers (a redirect, say) keeps them.
  }
  return response;
});
