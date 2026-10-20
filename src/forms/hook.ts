/**
 * A form's hook (the Forms plugin's Hook tab): the CMS posts each submission
 * to an address on the site before it keeps and emails it, signed with the
 * form's hook secret, and waits for the answer (librepublishgo
 * docs/forms.md, "The hook"; contracts/forms/form-hook-request.json). The
 * answer can send the visitor to another page, add values to the
 * submission, or refuse it with errors beside its fields.
 *
 *   // src/pages/api/quote-hook.ts
 *   import { formHook, FormHookRefusal } from "@librepublish/astro/forms/hook";
 *   export const prerender = false;
 *   export const POST = formHook(async (submission, context, hook) => {
 *     if (!(await served(submission.values.zip))) {
 *       hook.step("Zip check", "failed", `${submission.values.zip} isn't served`);
 *       throw new FormHookRefusal("We don't serve that zip yet.", { zip: ["isn't in our service area"] });
 *     }
 *     hook.step("Zip check", "ok");
 *     if (hook.test) {
 *       hook.step("Quote", "skipped", "a test");
 *       return {};
 *     }
 *     const quote = await createQuote(submission.values);
 *     hook.step("Quote", "ok", quote.id);
 *     return { redirect: `/quote?q=${quote.id}`, values: { quote_id: quote.id } };
 *   });
 *
 * The steps go back with the answer, a refusal or a failure too, and the CMS
 * shows them (its hook log, and the submission) as they're written: it
 * doesn't know what a zip check is. `hook.test` is set for Test hook (the
 * form's Testing tab): skip what a test shouldn't do.
 *
 * The secret is CMS_FORM_HOOK_SECRET (a Worker secret on Cloudflare), or
 * `secret` in the options. A post that isn't signed with it is refused (401)
 * before the handler runs. If the hook fails or is slow (the CMS waits 6
 * seconds), the submission still goes through as the form says, so a
 * handler that throws anything but a refusal answers 500 and the CMS carries
 * on without it.
 */
import { verify } from "../runtime/signature.js";

/** What the CMS posts: one submission, its answers by field name (checkboxes: several). */
export interface FormSubmission {
  event: "submission.created";
  form: string;
  form_name: string;
  submission_id: string;
  submitted_at: string;
  values: Record<string, string | string[]>;
  /** Set for a test (Test hook, in the form's Testing tab): nothing is kept, so don't do what a real one would. */
  test?: boolean;
}

/** How a step went. */
export type FormHookStepStatus = "ok" | "failed" | "skipped" | "warning" | "info";

/** Something the hook did, as the CMS shows it in its hook log and on the submission. */
export interface FormHookStep {
  label: string;
  status: FormHookStepStatus;
  detail?: string;
}

/** The handler's third argument: whether it's a test, and its steps. */
export interface FormHookTools {
  /** Set for Test hook: skip what a test shouldn't do (create a real quote). */
  readonly test: boolean;
  /** Notes a step; they go back with the answer, whatever it is. */
  step(label: string, status: FormHookStepStatus, detail?: string): void;
  /** The steps noted so far. */
  readonly steps: FormHookStep[];
}

/** What a hook answers, every key optional. */
export interface FormHookAnswer {
  /** Where the visitor goes instead of the form's thank-you: a path on the site, or an address on one of its origins. */
  redirect?: string;
  /** Shown to the visitor instead of the form's thank-you message. */
  message?: string;
  /** Kept with the submission: shown with it, in its CSV, and merge tags in its emails ({{ quote_id }}). Names are a-z, 0-9 and _. */
  values?: Record<string, string | number | boolean>;
  /** Steps besides those noted with hook.step, after them. */
  steps?: FormHookStep[];
}

/** Thrown by a handler to refuse the submission: the visitor sees the message, and each error beside its field. */
export class FormHookRefusal extends Error {
  constructor(message: string, readonly errors: Record<string, string[]> = {}) {
    super(message);
    this.name = "FormHookRefusal";
  }
}

export interface FormHookOptions {
  /** The form's hook secret. Default: CMS_FORM_HOOK_SECRET. */
  secret?: string;
  /** Only these forms (slugs); a post for another is refused (404). Default: any. */
  forms?: string[];
}

type Handler<C> = (submission: FormSubmission, context: C, hook: FormHookTools) => FormHookAnswer | void | Promise<FormHookAnswer | void>;

/** An Astro endpoint (`export const POST = formHook(…)`) that checks the CMS's signature, then runs the handler. */
export function formHook<C extends { request: Request }>(handler: Handler<C>, options: FormHookOptions = {}) {
  return async (context: C): Promise<Response> => {
    const secret = options.secret ?? (await envSecret());
    if (!secret) return json({ error: "CMS_FORM_HOOK_SECRET isn't set" }, 500);

    const body = await context.request.text();
    if (!(await verify(body, context.request.headers.get("X-CMS-Signature"), secret))) {
      return json({ error: "bad signature" }, 401);
    }
    let submission: FormSubmission;
    try {
      submission = JSON.parse(body) as FormSubmission;
    } catch {
      return json({ error: "the body isn't JSON" }, 400);
    }
    if (typeof submission?.form !== "string" || typeof submission.values !== "object" || submission.values === null) {
      return json({ error: "the body isn't a submission" }, 400);
    }
    if (options.forms && !options.forms.includes(submission.form)) {
      return json({ error: `not a hook for the form "${submission.form}"` }, 404);
    }

    const steps: FormHookStep[] = [];
    const tools: FormHookTools = {
      test: submission.test === true || context.request.headers.get("X-CMS-Test") === "1",
      step(label, status, detail) {
        steps.push(detail === undefined || detail === "" ? { label, status } : { label, status, detail: String(detail) });
      },
      get steps() { return steps; },
    };
    const withSteps = <T extends object>(body: T, more: FormHookStep[] = []) => {
      const all = [...steps, ...more];
      return all.length ? { ...body, steps: all } : body;
    };
    try {
      const { steps: more, ...answer } = (await handler(submission, context, tools)) ?? {};
      return json(withSteps(answer, more), 200);
    } catch (error) {
      if (error instanceof FormHookRefusal) return json(withSteps({ message: error.message, errors: error.errors }), 422);
      console.error(`[librepublish] form hook for "${submission.form}" failed:`, error);
      return json(withSteps({ error: "the hook failed" }, [{ label: "Hook", status: "failed", detail: error instanceof Error ? error.message : String(error) }]), 500);
    }
  };
}

/** One answer of a field, as a string: the first of several. */
export function answer(submission: FormSubmission, name: string): string {
  const value = submission.values[name];
  return (Array.isArray(value) ? value[0] : value)?.trim() ?? "";
}

async function envSecret(): Promise<string | undefined> {
  const { getSecret } = await import("astro:env/server");
  return getSecret("CMS_FORM_HOOK_SECRET");
}

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
