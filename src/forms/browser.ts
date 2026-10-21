/**
 * What a form does in the browser, shared by <Form>'s script and the
 * <FormIsland> a static site draws its forms with: read a definition, the
 * answers shown before anyone types, the post as the CMS takes it, and the
 * CMS's answer as the visitor reads it. Free of Astro and of any one
 * framework; it needs `fetch`, and `FileReader`-free `File`s (arrayBuffer).
 */
import { CmsError } from "../client.js";
import type { FieldErrors, RuledField } from "./rules.js";
import type { FormDefinition, FormField } from "./types.js";

// Here too, for code bundled for the browser: @librepublish/astro/forms reads the server's environment.
export { clientRules } from "./definition.js";

/** What the visitor reads for the answers that aren't about a field. */
export const MESSAGES = {
  closed: "This form isn't taking submissions.",
  rateLimited: "Too many tries: please wait a few minutes.",
  failed: "Something went wrong: please try again.",
  network: "Couldn't send: check your connection and try again.",
  invalid: "Please check the highlighted fields.",
  sending: "Sending…",
  sent: "Thanks — we got it.",
  unavailable: "This form couldn't be loaded. Please try again later.",
} as const;

/** Where a form's definition is read from: public, and CORS-enabled for the site's origins. */
export function definitionUrl(cms: string, slug: string): string {
  return `${cms.replace(/\/+$/, "")}/api/x/forms/definition?form=${encodeURIComponent(slug)}`;
}

/**
 * A form's live definition, read from the browser. Throws a CmsError whose
 * status is 0 when the CMS couldn't be reached, 404 when there's no such form.
 */
export async function fetchDefinition(cms: string, slug: string, fetcher: typeof fetch = fetch): Promise<FormDefinition> {
  const url = definitionUrl(cms, slug);
  let response: Response;
  try {
    // Asked again each time (the CMS lets it be kept 60 s): a definition edited in the CMS shows at once.
    response = await fetcher(url, { headers: { Accept: "application/json" }, credentials: "omit", cache: "no-cache" });
  } catch (error) {
    throw new CmsError(`CMS: couldn't reach ${cms} (${(error as Error).message})`, 0, url, null);
  }
  const body = await response.json().catch(() => null) as { form?: FormDefinition } | null;
  if (response.status === 404) throw new CmsError(`CMS: there's no form "${slug}", or the Forms plugin is off.`, 404, url, body);
  if (!response.ok || !body?.form) throw new CmsError(`CMS: the form "${slug}" answered ${response.status}`, response.status, url, body);
  return body.form;
}

/** What's entered before anyone answers: each field's default (a consent box's "yes"/"true" ticks it). */
export function defaultValues(fields: FormField[]): Record<string, string[]> {
  const values: Record<string, string[]> = {};
  for (const field of fields) {
    if (!field.name || field.type === "heading") continue;
    if (field.type === "checkbox") { if (field.default === "yes" || field.default === "true") values[field.name] = ["yes"]; }
    else if (field.default) values[field.name] = [field.default];
  }
  return values;
}

/** A file as a JSON post carries it (docs/forms.md). */
export interface PostedJsonFile { filename: string; content_type: string; data: string }

/**
 * A form's entries as the JSON the CMS's submit endpoint takes: checkboxes
 * as a list, a file as `{filename, content_type, data}` (base64), everything
 * else as a string. A field its condition hides (not in `visible`) is left
 * out, whatever its control holds; names that aren't fields (_hp, _ts, a
 * captcha's token) go as they are.
 */
export async function jsonBody(
  fields: RuledField[],
  entries: Iterable<[string, unknown]>,
  visible: Set<string>,
): Promise<Record<string, unknown>> {
  const types = new Map(fields.map((field) => [field.name, field.type]));
  const body: Record<string, unknown> = {};
  for (const [rawName, value] of entries) {
    const name = rawName.endsWith("[]") ? rawName.slice(0, -2) : rawName;
    const type = types.get(name);
    if (type !== undefined && !visible.has(name)) continue;
    if (typeof value === "string") {
      const before = body[name];
      // Checkboxes are always a list; any other name posted twice becomes one.
      if (type === "checkboxes" || before !== undefined) body[name] = [...(before === undefined ? [] : ([] as unknown[]).concat(before)), value];
      else body[name] = value;
    } else if (isFile(value)) {
      // An empty file input posts an empty, nameless file: nothing chosen. The CMS takes one file a field.
      if (!value.name && value.size === 0) continue;
      if (!(name in body)) body[name] = { filename: value.name, content_type: value.type || "application/octet-stream", data: base64(new Uint8Array(await value.arrayBuffer())) } satisfies PostedJsonFile;
    }
  }
  return body;
}

interface FileLike { name: string; type: string; size: number; arrayBuffer(): Promise<ArrayBuffer> }
function isFile(value: unknown): value is FileLike {
  return Boolean(value) && typeof value === "object" && typeof (value as FileLike).arrayBuffer === "function" && "size" in (value as object);
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/** The CMS's answer to a post, as the visitor reads it. */
export type Outcome =
  | { ok: true; status: number; message: string; redirect: string }
  | { ok: false; status: number; message: string; errors: FieldErrors; error?: string };

/**
 * Reads the CMS's answer (contracts/forms/form-submit-*): 200 `{ok, message,
 * redirect}`; 422 `{errors}` for each field (and "captcha"); 410 closed; 429
 * too many; status 0 for a post that never got there.
 */
export function outcome(status: number, answer: unknown, success: string = MESSAGES.sent): Outcome {
  const body = (answer && typeof answer === "object" ? answer : {}) as { message?: string; redirect?: string; errors?: FieldErrors; error?: string };
  if (status >= 200 && status < 300) return { ok: true, status, message: body.message || success, redirect: body.redirect || "" };
  const message =
    status === 0 ? MESSAGES.network
    : status === 410 ? MESSAGES.closed
    : status === 429 ? MESSAGES.rateLimited
    : body.message ?? MESSAGES.failed;
  return { ok: false, status, message, errors: body.errors ?? {}, ...(body.error ? { error: body.error } : {}) };
}

/** Posts a JSON body to a definition's `action` and reads the answer. Never throws: a network failure is status 0. */
export async function submit(action: string, body: Record<string, unknown>, options: { success?: string; fetcher?: typeof fetch } = {}): Promise<Outcome> {
  const fetcher = options.fetcher ?? fetch;
  try {
    const response = await fetcher(action, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
      credentials: "omit",
    });
    return outcome(response.status, await response.json().catch(() => ({})), options.success);
  } catch {
    return outcome(0, null);
  }
}
