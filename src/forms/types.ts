/**
 * The Forms plugin's public contract (plugins/forms): a form's definition,
 * as GET /api/x/forms/definition?form=<slug> answers `{ form }`, and what
 * POST /api/x/forms/submit?form=<slug> answers.
 */

/** The builder's palette (plugins/forms/manifest.go). "heading" is layout: it posts nothing. */
export const FIELD_TYPES = [
  "text", "email", "tel", "textarea", "number", "select", "radio", "checkboxes", "checkbox", "date", "url", "file", "hidden", "heading",
] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

/**
 * How a field is checked, declared by the CMS (plugins/forms/rules.go). The server
 * stays the authority; the site checks the same rules first so a visitor
 * hears at once. Absent on layout fields (a heading); a key that doesn't
 * apply to the field's type is left out.
 */
export interface FieldRules {
  /** Always there: a checkbox must be ticked, a choice made. */
  required: boolean;
  /** Characters, per value; the CMS resolves the default (500, or 10,000 for a textarea). */
  max_length?: number;
  min?: number;
  max?: number;
  /** email, tel, url, date, number: a regular expression source Go and JavaScript read alike, matched against the trimmed answer. */
  pattern?: string;
  /** File fields: extensions (".pdf") and media types ("image/*", "application/pdf"). */
  accept?: string[];
  /** File fields: the largest file, in MB (the CMS resolves the default, 5). */
  max_mb?: number;
  /** select, radio, checkboxes: the values allowed. */
  options?: string[];
}

export interface FormField {
  type: FieldType;
  /** What the site posts it as; "" on a heading. */
  name: string;
  label: string;
  placeholder?: string;
  help?: string;
  required?: boolean;
  /** "half" sits beside the next half field; anything else is full width. */
  width?: "half" | "full" | string;
  options?: string[];
  default?: string;
  /** A heading's text, or a consent checkbox's sentence. */
  text?: string;
  rows?: number;
  min?: number;
  max?: number;
  max_length?: number;
  accept?: string;
  max_mb?: number;
  rules?: FieldRules;
}

export interface FormCaptcha {
  provider: "turnstile" | "recaptcha";
  site_key: string;
  /** The field the widget posts its token in (cf-turnstile-response, g-recaptcha-response). */
  field: string;
  /** The provider's script, to load on the page. */
  script: string;
}

export interface FormDefinition {
  slug: string;
  name: string;
  /** false: closed, and a submission is answered 410. */
  open: boolean;
  fields: FormField[];
  submit_label: string;
  success_message: string;
  /** Where to send the visitor after a submission ("" to show the message). */
  redirect_url: string;
  /** Where the browser posts: the CMS's submit endpoint. */
  action: string;
  /** "sha256:" and the hex SHA-256 of the canonical JSON of every other key of the definition. */
  digest: string;
  spam: {
    /** "_hp" when the honeypot is on, "" when off. */
    honeypot_field: string;
    /** "_ts" when a minimum time is set, "" when off. */
    timestamp_field: string;
    /** The fewest seconds between the page loading and the post (0: off). */
    min_seconds: number;
    captcha: FormCaptcha | null;
  };
}

/** GET /api/x/forms/list. */
export interface FormList {
  forms: { slug: string; name: string; open: boolean; digest: string }[];
}

/** 200 */
export interface FormAccepted { ok: true; message: string; redirect: string }

/** 422 (invalid, captcha), 410 (closed), 429, 400 … */
export interface FormRejected {
  error: "invalid" | "closed" | "rate_limited" | "bad_request" | "not_found" | string;
  message?: string;
  /** Per field; "captcha" for the captcha. */
  errors?: Record<string, string[]>;
}
