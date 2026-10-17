/**
 * The CMS connection when a page renders: from astro:env (CMS_BASE_URL and
 * CMS_API_TOKEN; on Cloudflare, the Worker's variables and secrets), or, while
 * the build prerenders in Node, the connection the integration resolved.
 *
 * On Cloudflare, prerender in Node — `cloudflare({ prerenderEnvironment:
 * "node" })` — or give workerd the variables (.dev.vars, or `vars` and
 * secrets in wrangler's config): workerd doesn't read .env at build time.
 */
import { getSecret } from "astro:env/server";
import { buildState, heldConnection } from "../build-connection.js";
import { createClient, type CmsClient } from "../client.js";

/** The schema digest the site was built against (cms.lock.json), set by the integration at build time. */
declare const __LIBREPUBLISH_SCHEMA_DIGEST__: string | undefined;
export const BUILT_SCHEMA_DIGEST: string | undefined =
  typeof __LIBREPUBLISH_SCHEMA_DIGEST__ === "string" ? __LIBREPUBLISH_SCHEMA_DIGEST__ : undefined;

export function runtimeConnection(): { url: string; token: string } {
  const url = getSecret("CMS_BASE_URL");
  const token = getSecret("CMS_API_TOKEN");
  if (url && token) return { url, token };

  const built = heldConnection();
  if (built) return built;

  throw new Error(
    "@librepublish/astro: CMS_BASE_URL and CMS_API_TOKEN aren't set where this page renders. " +
    "On Cloudflare, set them as the Worker's variables and secrets (locally: .dev.vars beside the wrangler config); " +
    'for prerendering at build time, use cloudflare({ prerenderEnvironment: "node" }).',
  );
}

export function runtimeClient(options: { tags?: Set<string> } = {}): CmsClient {
  // While the build prerenders, every answer's schema digest is checked at the end of the build.
  const digests = heldConnection() ? buildState().digests : undefined;
  return createClient({ ...runtimeConnection(), ...options, digests });
}

let warned: string | undefined;
/**
 * A page rendered on demand reading a CMS whose schema moved since the build:
 * the site's code was checked against the old one. Said once per digest; the
 * CMS's `schema.changed` webhook is what should trigger the rebuild.
 */
export function warnIfSchemaMoved(digest: string | undefined): boolean {
  if (!digest || !BUILT_SCHEMA_DIGEST || digest === BUILT_SCHEMA_DIGEST) return false;
  if (warned !== digest) {
    warned = digest;
    console.warn(`[librepublish] The CMS's schema (${digest}) isn't the one this site was built against (${BUILT_SCHEMA_DIGEST}, cms.lock.json). Rebuild after \`npx librepublish-astro sync\`.`);
  }
  return true;
}
