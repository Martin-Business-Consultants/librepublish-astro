/**
 * librepublish-astro — the schema lock, from the command line:
 *
 *   npx librepublish-astro sync     read the CMS's schema now and write cms.lock.json
 *   npx librepublish-astro check    exit 1 when the CMS's schema isn't the locked one
 *
 * It reads CMS_BASE_URL and CMS_API_TOKEN as `astro build` does (the
 * environment, then .env). After a sync, run `astro check`: the generated
 * types follow the new schema, so it names every place the site must change.
 */
import { resolve } from "node:path";
import { createClient } from "./client.js";
import { resolveConnection } from "./connection.js";
import { decide, describeChanges, LOCK_FILE, lockFrom, readLock, writeLock } from "./lock.js";
import { readLive } from "./schema/live.js";

export async function main(argv: string[], out: (line: string) => void = console.log): Promise<number> {
  const [command = "help", ...rest] = argv;
  const rootIndex = rest.indexOf("--root");
  const root = resolve(rootIndex >= 0 ? rest[rootIndex + 1] ?? "." : ".");

  if (command !== "sync" && command !== "check") {
    out("usage: librepublish-astro sync|check [--root <site>]");
    out("  sync   read the CMS's schema and write cms.lock.json (then: astro check, commit it)");
    out("  check  exit 1 when the CMS's schema isn't the one cms.lock.json records");
    return command === "help" || command === "--help" || command === "-h" ? 0 : 2;
  }

  const connection = resolveConnection(root, "production", {});
  if (!connection) {
    out("CMS_BASE_URL and CMS_API_TOKEN aren't set (environment or .env).");
    return 2;
  }
  const client = createClient(connection);
  const site = await client.site();
  const { live } = await readLive(client, site, connection.url);
  const lock = await readLock(root);

  if (command === "check") {
    const decision = decide(lock, live, { command: "build", accept: false });
    if (decision.action === "ok") {
      out(`${LOCK_FILE} matches the CMS's schema (${live.digest}).`);
      return 0;
    }
    out(decision.action === "fail" ? decision.message : "");
    return 1;
  }

  const changes = lock ? describeChanges(lock.parts ?? {}, live.parts) : [];
  await writeLock(root, lockFrom(live));
  if (lock?.schema_digest === live.digest) {
    out(`${LOCK_FILE} already matches the CMS's schema (${live.digest}); refreshed its details.`);
  } else {
    out(`Wrote ${LOCK_FILE}: ${live.digest}${lock ? ` (was ${lock.schema_digest})` : ""}.`);
    for (const line of changes) out(`  ${line}`);
    out("Next: astro check (the types follow the new schema), then commit cms.lock.json.");
  }
  return 0;
}
