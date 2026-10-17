// Astro's virtual modules, as the runtime code uses them (the real types
// come from astro/client in a site; this keeps the package's own build honest).
declare module "astro:env/server" {
  export function getSecret(key: string): string | undefined;
}

declare module "astro:middleware" {
  import type { MiddlewareHandler } from "astro";
  export function defineMiddleware(handler: MiddlewareHandler): MiddlewareHandler;
}

// What the package itself uses of the generated module. In a site, the
// integration generates the real one from the CMS's schema
// (.astro/integrations/librepublish/cms.d.ts); this file isn't published.
declare module "librepublish:types" {
  import type { CmsEntry, CmsPage } from "./types.js";
  export type Page = CmsPage;
  export interface Entries { [collection: string]: CmsEntry }
}

declare namespace App {
  interface Locals {
    /** A client for this request (pages rendered on demand); its answers' cache tags go out as Cache-Tag. */
    cms: import("./client.js").CmsClient;
    /** The cache tags this response will carry. */
    cmsTags: Set<string>;
  }
}
