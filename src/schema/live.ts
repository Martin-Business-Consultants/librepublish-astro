/**
 * Reading the CMS's schema as the lock records it: its digest (the CMS's own,
 * meta.schema_digest), a digest per part, the CMS's version and each form's
 * digest. Node only (build time and the CLI).
 */
import type { CmsClient } from "../client.js";
import type { LiveSchema } from "../lock.js";
import type { CmsSchema, CmsSite, CmsSiteMeta } from "../types.js";
import { partDigests } from "./digest.js";

export interface LiveRead {
  schema: CmsSchema;
  live: LiveSchema;
}

export async function readLive(client: CmsClient, site: { data: CmsSite; meta: CmsSiteMeta } | null, cmsUrl: string): Promise<LiveRead> {
  const answer = await client.schema();
  const digest = answer.meta?.schema_digest;
  if (typeof digest !== "string" || !digest.startsWith("sha256:")) {
    throw new Error(`The CMS at ${cmsUrl} sent no schema digest (GET /api/v1/schema's meta.schema_digest): it's older than this version of @librepublish/astro reads. Update the CMS.`);
  }
  return {
    schema: answer.data,
    live: {
      cmsUrl,
      apiVersion: site?.data.api_version ?? "v1",
      cmsVersion: answer.meta.cms_version ?? site?.meta.cms_version ?? "",
      digest,
      parts: partDigests(answer.data),
      forms: await formDigests(client, site?.data.plugins ?? []),
    },
  };
}

/** Each form's digest, from the Forms plugin's list; {} when Forms is off. */
async function formDigests(client: CmsClient, plugins: string[]): Promise<Record<string, string>> {
  if (!plugins.includes("forms")) return {};
  const { forms } = await client.formList();
  return Object.fromEntries(forms.map((form) => [form.slug, form.digest] as const).sort(([a], [b]) => (a < b ? -1 : 1)));
}
