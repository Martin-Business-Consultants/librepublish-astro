/**
 * POST /_cms/checks — the CMS's launch checklist asking the live site what
 * only it can see: whether its runtime variables are set, and whether it
 * shares a form hook's secret. Signed; see checks-answer.ts.
 */
import type { APIRoute } from "astro";
import { getSecret } from "astro:env/server";
import { answerChecks } from "./checks-answer.js";

export const prerender = false;

/** The variables the site said it runs on (cms({ env: { runtime } })), set by the integration at build time. */
declare const __LIBREPUBLISH_RUNTIME_ENV__: string[] | undefined;
/** This package's version, set by the integration at build time. */
declare const __LIBREPUBLISH_VERSION__: string | undefined;

export const POST: APIRoute = async ({ request }) => {
  const runtime = typeof __LIBREPUBLISH_RUNTIME_ENV__ !== "undefined" ? __LIBREPUBLISH_RUNTIME_ENV__ : [];
  const version = typeof __LIBREPUBLISH_VERSION__ === "string" ? __LIBREPUBLISH_VERSION__ : "";
  const answer = await answerChecks(await request.text(), request.headers, (name) => getSecret(name) || undefined, runtime, version);
  return new Response(JSON.stringify(answer.body), {
    status: answer.status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
};
