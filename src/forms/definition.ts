/**
 * What <Form>'s script gets from a definition: the messages and, for each
 * field that posts, its name, type, label and rules. Pure, so it's testable
 * without Astro's virtual modules.
 */
import type { FormDefinition } from "./types.js";

/**
 * What <Form> needs to draw a definition: a list of messages and the fields
 * it checks in the browser. Not a way to draw fields by hand.
 */
export function clientRules(definition: FormDefinition) {
  return {
    slug: definition.slug,
    success: definition.success_message || "Thanks — we got it.",
    redirect: definition.redirect_url,
    fields: definition.fields
      .filter((field) => field.type !== "heading" && field.name)
      .map((field) => ({ name: field.name, type: field.type, label: field.label || field.name, rules: field.rules })),
  };
}
