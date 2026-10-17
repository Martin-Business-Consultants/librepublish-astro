/**
 * What the integration resolved for this build — the connection, and the
 * schema it checked against cms.lock.json — kept on globalThis for the code
 * that runs in the same process: the content loaders and the prerendering
 * pages. Free of Vite and Node imports, so it can sit in code that's bundled
 * for a Worker too.
 */
import { createClient, type CmsClient } from "./client.js";
import type { CmsSchema } from "./types.js";

export interface Connection { url: string; token: string }

/** The schema a build runs against: read once, its digest checked against the lock. */
export interface LockedSchema { schema: CmsSchema; digest: string }

interface BuildState {
  connection?: Connection;
  /** The schema the integration read and checked against the lock. */
  schema?: Promise<LockedSchema>;
  /** Every schema digest the CMS's answers carried during this build. */
  digests: Set<string>;
}

const KEY = Symbol.for("librepublish.astro.build");
type Holder = { [KEY]?: BuildState };

export function buildState(): BuildState {
  return ((globalThis as Holder)[KEY] ??= { digests: new Set() });
}

export function keepConnection(connection: Connection) {
  buildState().connection = connection;
}

/** The build's connection, or null outside a build that has one. */
export function heldConnection(): Connection | null {
  return buildState().connection ?? null;
}

/** The build's connection; throws outside a build that has one. */
export function buildConnection(): Connection {
  const connection = heldConnection();
  if (!connection) {
    throw new Error("@librepublish/astro: no CMS connection. Add cms() to astro.config's integrations and set CMS_BASE_URL and CMS_API_TOKEN.");
  }
  return connection;
}

export function buildClient(): CmsClient {
  return createClient({ ...buildConnection(), digests: buildState().digests });
}

/** Keep the schema the integration checked, for the loaders. */
export function keepSchema(schema: Promise<LockedSchema>) {
  buildState().schema = schema;
}

/** The schema the integration checked against the lock, or null when it didn't (a test, a loader without cms()). */
export function heldSchema(): Promise<LockedSchema> | null {
  return buildState().schema ?? null;
}
