/**
 * POST /_cms/webhook — the CMS telling an on-demand site what changed, signed
 * with CMS_WEBHOOK_SECRET (X-CMS-Signature-V2 over the timestamp and body,
 * or from a CMS before 2.8.0 X-CMS-Signature over the body alone,
 * contracts/webhook_contract.json). What it asks for is
 * runtime/purge.ts's. With CLOUDFLARE_ZONE_ID and CLOUDFLARE_API_TOKEN set, it
 * purges those cache tags (or everything) from Cloudflare's cache; either way
 * it answers what it did, and the CMS logs it.
 */
import type { APIRoute } from "astro";
import { getSecret } from "astro:env/server";
import { plan } from "./purge.js";
import { verifyRequest } from "./signature.js";

export const prerender = false;

export const POST: APIRoute = async ({ request }) => {
  const secret = getSecret("CMS_WEBHOOK_SECRET");
  if (!secret) return json({ error: "CMS_WEBHOOK_SECRET isn't set" }, 500);

  const body = await request.text();
  if (!(await verifyRequest(body, request.headers, secret))) {
    return json({ error: "bad signature" }, 401);
  }

  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return json({ error: "the body isn't JSON" }, 400);
  }
  const todo = plan(payload);
  if (todo.kind === "ignore") return json({ ignored: todo.event });
  if (todo.kind === "rebuild") {
    console.warn(`[librepublish] ${todo.reason}`);
    return json({ purged: false, rebuild_required: true, reason: todo.reason, schema_digest: todo.schema_digest ?? null }, 202);
  }

  const zone = getSecret("CLOUDFLARE_ZONE_ID");
  const token = getSecret("CLOUDFLARE_API_TOKEN");
  if (!zone || !token) return json({ purged: false, reason: "CLOUDFLARE_ZONE_ID and CLOUDFLARE_API_TOKEN aren't set", tags: todo.tags });

  // Cloudflare takes at most 100 tags a request.
  const batches = todo.all ? [{ purge_everything: true }] : chunk(todo.tags, 100).map((part) => ({ tags: part }));
  for (const batch of batches) {
    const response = await fetch(`https://api.cloudflare.com/client/v4/zones/${zone}/purge_cache`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(batch),
    });
    if (!response.ok) return json({ purged: false, status: response.status, cloudflare: await response.text() }, 502);
  }
  return json({ purged: true, all: todo.all, tags: todo.all ? [] : todo.tags });
};

function chunk<T>(list: T[], size: number): T[][] {
  const parts: T[][] = [];
  for (let i = 0; i < list.length; i += size) parts.push(list.slice(i, i + size));
  return parts.length ? parts : [[]];
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
