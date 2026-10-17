/**
 * The CMS's forms on the site (the Forms plugin). A form is built in the CMS
 * and drawn from its live definition on every request:
 *
 *   ---
 *   import Form from "@librepublish/astro/components/Form.astro";
 *   export const prerender = false;   // <Form> renders on demand
 *   ---
 *   <Form slug="contact" />
 *
 * There are no field components to build a form by hand: what the CMS
 * defines is what the visitor sees, and nothing on the site can go stale.
 * The browser posts straight to the CMS (`definition.action`).
 */
import { CmsError } from "../client.js";
import { runtimeClient } from "../runtime/env.js";
import type { FormDefinition } from "./types.js";

export type * from "./types.js";
export { FIELD_TYPES } from "./types.js";
export { clientRules } from "./definition.js";

/** A form's live definition, read now (never cached by the site). */
export async function formDefinition(slug: string): Promise<FormDefinition> {
  try {
    return await runtimeClient().formDefinition(slug);
  } catch (error) {
    if (error instanceof CmsError && error.status === 404) {
      throw new CmsError(`CMS: there's no form "${slug}", or the Forms plugin is off (Settings › Plugins).`, 404, error.path, error.body);
    }
    throw error;
  }
}
