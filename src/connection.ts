/**
 * Where the CMS is and how to reach it. At build time the integration resolves
 * it once (options, then the environment and .env) and keeps it for the
 * content loaders, which run in the same process (build-connection.ts). At
 * request time the runtime reads it from astro:env (runtime/env.ts), which on
 * Cloudflare means the Worker's variables and secrets.
 */
import { loadEnv } from "vite";
import type { Connection } from "./build-connection.js";

export { buildClient, buildConnection, buildState, keepConnection, keepSchema, type Connection } from "./build-connection.js";

export function resolveConnection(root: string, mode: string, options: { url?: string; token?: string }): Connection | null {
  const env = { ...loadEnv(mode, root, ""), ...process.env };
  const url = options.url ?? env.CMS_BASE_URL;
  const token = options.token ?? env.CMS_API_TOKEN;
  return url && token ? { url: url.replace(/\/+$/, ""), token } : null;
}
