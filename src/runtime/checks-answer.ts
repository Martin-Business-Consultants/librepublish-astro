/**
 * What POST /_cms/checks answers (runtime/checks.ts): the live site telling
 * the CMS's launch checklist what only it can see. The CMS signs the post as
 * it signs a webhook (X-CMS-Signature-V2 over X-CMS-Timestamp and the body),
 * with one of two secrets the site shares with it:
 *
 *   - CMS_WEBHOOK_SECRET, Settings › Deploy's purge secret: the CMS asks
 *     whether the variables the site runs on (cms({ env: { runtime } })) are
 *     set where it runs;
 *   - CMS_FORM_HOOK_SECRET, a form's hook secret: Forms asks whether the
 *     site's secret is the form's (a post it signed verifies here).
 *
 * The answer says which secret verified it, and for each variable only
 * whether it's set: never a value. An unsigned or badly signed post gets a
 * 401 and nothing else.
 */
import { verifyRequest } from "./signature.js";

export interface ChecksAnswer {
  status: number;
  body: Record<string, unknown>;
}

export async function answerChecks(
  body: string,
  headers: Headers,
  secret: (name: string) => string | undefined,
  runtime: string[],
  version: string,
  now = Date.now(),
): Promise<ChecksAnswer> {
  const webhook = secret("CMS_WEBHOOK_SECRET");
  const formHook = secret("CMS_FORM_HOOK_SECRET");
  let verifiedWith: string | null = null;
  if (webhook && (await verifyRequest(body, headers, webhook, now))) verifiedWith = "webhook";
  else if (formHook && (await verifyRequest(body, headers, formHook, now))) verifiedWith = "form_hook";
  if (!verifiedWith) return { status: 401, body: { error: "bad signature" } };
  return {
    status: 200,
    body: {
      ok: true,
      verified_with: verifiedWith,
      env: Object.fromEntries(runtime.map((name) => [name, Boolean(secret(name))])),
      secrets: { webhook: Boolean(webhook), form_hook: Boolean(formHook) },
      integration_version: version,
    },
  };
}
