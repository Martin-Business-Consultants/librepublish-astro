/**
 * cms.lock.json: the CMS schema a site was written against, committed beside
 * astro.config. A build, `astro sync` and `astro check` compare the live
 * schema's digest with it and stop when they differ, so a site never ships
 * against a schema its components and types weren't checked with:
 *
 *   npx librepublish-astro sync     # take the CMS's schema now; then astro check, commit
 *
 * `astro dev` takes a new schema itself (and says so). LIBREPUBLISH_ACCEPT_SCHEMA=1
 * takes it in any command — for CI that opens a pull request with the new lock.
 */
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const LOCK_FILE = "cms.lock.json";
export const ACCEPT_ENV = "LIBREPUBLISH_ACCEPT_SCHEMA";
export const SYNC_COMMAND = "npx librepublish-astro sync";

export interface CmsLock {
  $comment?: string;
  lock_version: 1;
  /** Where the schema was read (for reference: staging and production may differ). */
  cms_url: string;
  api_version: string;
  /** The CMS's version when the lock was written (for reference). */
  cms_version: string;
  /** What's compared: "sha256:<hex>" of the schema's canonical JSON. */
  schema_digest: string;
  /** A short digest of each block type, collection, global, page with fields and SEO, to say what changed. */
  parts: Record<string, string>;
  /** Each form's definition digest, for reference (forms render live; a change needs no build). */
  forms: Record<string, string>;
}

/** What the integration and the CLI read from the CMS now. */
export interface LiveSchema {
  cmsUrl: string;
  apiVersion: string;
  cmsVersion: string;
  digest: string;
  parts: Record<string, string>;
  forms: Record<string, string>;
}

export function lockFrom(live: LiveSchema): CmsLock {
  return {
    $comment: `The CMS schema this site is built against. Update it with \`${SYNC_COMMAND}\`; commit it.`,
    lock_version: 1,
    cms_url: live.cmsUrl,
    api_version: live.apiVersion,
    cms_version: live.cmsVersion,
    schema_digest: live.digest,
    parts: live.parts,
    forms: live.forms,
  };
}

export async function readLock(root: string): Promise<CmsLock | null> {
  let text: string;
  try {
    text = await readFile(join(root, LOCK_FILE), "utf8");
  } catch {
    return null;
  }
  const lock = JSON.parse(text) as CmsLock;
  if (lock.lock_version !== 1 || typeof lock.schema_digest !== "string") {
    throw new Error(`${LOCK_FILE} isn't one this version of @librepublish/astro reads; run \`${SYNC_COMMAND}\`.`);
  }
  return lock;
}

export async function writeLock(root: string, lock: CmsLock): Promise<void> {
  await writeFile(join(root, LOCK_FILE), `${JSON.stringify(lock, null, 2)}\n`);
}

export type Command = "dev" | "build" | "preview" | "sync";

export type LockDecision =
  | { action: "ok" }
  | { action: "write"; level: "info" | "warn"; message: string }
  | { action: "fail"; message: string };

/**
 * What a command does with the lock and the live schema:
 *   same digest → ok;
 *   accepted (LIBREPUBLISH_ACCEPT_SCHEMA=1) → write it;
 *   dev → write it, with a warning;
 *   build and sync (astro sync, astro check) → fail, saying what changed and what to run.
 */
export function decide(lock: CmsLock | null, live: LiveSchema, options: { command: Command; accept: boolean }): LockDecision {
  if (lock && lock.schema_digest === live.digest) return { action: "ok" };
  if (options.command === "preview") return { action: "ok" };

  if (!lock) {
    if (options.accept || options.command === "dev") {
      return { action: "write", level: "info", message: `Wrote ${LOCK_FILE} from the CMS's schema (${short(live.digest)}). Commit it.` };
    }
    return {
      action: "fail",
      message: `There's no ${LOCK_FILE}: the site has no record of the CMS schema it's written against. Run \`${SYNC_COMMAND}\`, check the site (astro check), and commit ${LOCK_FILE}.`,
    };
  }

  const changes = describeChanges(lock.parts ?? {}, live.parts);
  const summary = [
    `The CMS's schema has changed since ${LOCK_FILE} was written (${short(lock.schema_digest)} → ${short(live.digest)}):`,
    ...(changes.length ? changes.map((line) => `  ${line}`) : ["  (no part's digest differs: the schema's canonical form changed)"]),
  ].join("\n");

  if (options.accept) return { action: "write", level: "warn", message: `${summary}\n${ACCEPT_ENV}=1: took the new schema and rewrote ${LOCK_FILE}.` };
  if (options.command === "dev") {
    return { action: "write", level: "warn", message: `${summary}\nastro dev took the new schema and rewrote ${LOCK_FILE}; run astro check and commit it.` };
  }
  return {
    action: "fail",
    message: `${summary}\nThis site was checked against the old one. Run \`${SYNC_COMMAND}\`, fix what \`astro check\` reports, and commit ${LOCK_FILE}. (CI that opens a pull request for it can set ${ACCEPT_ENV}=1.)`,
  };
}

/** "+ blocks/promo", "- collections/old", "~ blocks/hero", sorted. */
export function describeChanges(before: Record<string, string>, after: Record<string, string>): string[] {
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  const lines: string[] = [];
  for (const key of keys) {
    if (!(key in before)) lines.push(`+ ${key}`);
    else if (!(key in after)) lines.push(`- ${key}`);
    else if (before[key] !== after[key]) lines.push(`~ ${key}`);
  }
  return lines;
}

export function accepted(env: Record<string, string | undefined> = process.env): boolean {
  return /^(1|true|yes)$/i.test(env[ACCEPT_ENV] ?? "");
}

function short(digest: string): string {
  return digest.replace(/^sha256:/, "").slice(0, 12);
}
