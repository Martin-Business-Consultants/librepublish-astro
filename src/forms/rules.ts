/**
 * The one client-side check every form uses, driven only by the `rules` the
 * CMS declares on each field of a form's definition — no form has code of its
 * own. Its messages are the server's (plugins/forms/submit.go), so a visitor
 * reads the same sentence whichever side caught it. The server stays the
 * authority: what passes here is checked again there.
 *
 * Free of the DOM, so it runs in the browser (<Form>'s script), on the server
 * and in tests alike.
 */
import type { FieldRules, FieldType, ShowIf } from "./types.js";

/** What a field needs to be checked: its name, type (for the wording), rules, and when it's shown. */
export interface RuledField {
  name: string;
  type: FieldType | string;
  rules?: FieldRules;
  show_if?: ShowIf;
}

/** A file as the browser gives it (File has these). */
export interface PostedFile { name: string; type: string; size: number }

/** What was entered: every value of each name (checkboxes have several), and the files chosen. */
export interface Posted {
  values: Record<string, string[]>;
  files?: Record<string, PostedFile[]>;
}

export type FieldErrors = Record<string, string[]>;

const FORMAT_MESSAGE: Record<string, string> = {
  email: "isn't an email address",
  tel: "isn't a phone number",
  url: "isn't a web address (https://…)",
  date: "isn't a date",
  number: "isn't a number",
};

/**
 * Where the server is stricter than the pattern, on purpose (docs/forms.md):
 * a date must be a real one (2026-02-30 matches but isn't), a URL must parse
 * with an http(s) scheme and a host, a number mustn't overflow.
 */
const STRICT: Record<string, (value: string) => boolean> = {
  date: (value) => {
    const [y, m, d] = value.split("-").map(Number);
    const date = new Date(0);
    date.setUTCFullYear(y, m - 1, d);
    return m >= 1 && m <= 12 && date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
  },
  url: (value) => {
    // Go's url.Parse refuses a % that doesn't start an escape; the WHATWG parser lets it by.
    if (/%(?![0-9a-fA-F]{2})/.test(value)) return false;
    try {
      const url = new URL(value);
      return (url.protocol === "http:" || url.protocol === "https:") && url.host !== "";
    } catch {
      return false;
    }
  },
  number: (value) => Number.isFinite(Number(value)),
};

/** Every shown field's problems, by name; {} when there are none. A field its condition hides isn't asked for. */
export function validate(fields: RuledField[], posted: Posted): FieldErrors {
  const errors: FieldErrors = {};
  const visible = shown(fields, posted);
  for (const field of fields) {
    if (!visible.has(field.name)) continue;
    const problems = check(field, posted);
    if (problems.length) errors[field.name] = problems;
  }
  return errors;
}

/**
 * The fields shown, given what's entered, as the CMS decides it
 * (plugins/forms/hook.go): one with no `show_if` always is; one with a
 * condition is when the field it names is shown and has one of its values.
 * A condition names an earlier field, so one pass in order settles it.
 */
export function shown(fields: RuledField[], posted: Posted): Set<string> {
  const out = new Set<string>();
  for (const field of fields) {
    if (!field.name) continue;
    const condition = field.show_if;
    if (!condition) {
      out.add(field.name);
      continue;
    }
    const answers = (posted.values[condition.field] ?? []).map((value) => value.trim()).filter(Boolean);
    if (out.has(condition.field) && answers.some((answer) => condition.values.includes(answer))) out.add(field.name);
  }
  return out;
}

/** One field's problems. */
export function check(field: RuledField, posted: Posted): string[] {
  const rules = field.rules;
  if (!rules || !field.name) return [];

  const files = (posted.files?.[field.name] ?? []).filter((file) => file.size > 0 || file.name);
  if (field.type === "file" || rules.accept || rules.max_mb !== undefined) {
    if (files.length === 0) return rules.required ? ["choose a file"] : [];
    for (const file of files) {
      const problem = fileProblem(rules, file);
      if (problem) return [problem];
    }
    return [];
  }

  const values = (posted.values[field.name] ?? []).map((value) => value.trim()).filter(Boolean);
  if (values.length === 0) return rules.required ? [requiredMessage(field.type)] : [];

  if (rules.max_length !== undefined) {
    for (const value of values) {
      if ([...value].length > rules.max_length) return [`is longer than ${rules.max_length} characters`];
    }
  }
  const value = values[0];
  if (rules.pattern !== undefined && (!compile(rules.pattern).test(value) || STRICT[field.type]?.(value) === false)) {
    return [FORMAT_MESSAGE[field.type] ?? "isn't in the right format"];
  }
  if (rules.min !== undefined || rules.max !== undefined || field.type === "number") {
    const number = Number(value);
    if (!Number.isFinite(number)) return ["isn't a number"];
    if (rules.min !== undefined && number < rules.min) return [`is at least ${format(rules.min)}`];
    if (rules.max !== undefined && number > rules.max) return [`is at most ${format(rules.max)}`];
  }
  if (rules.options) {
    // One answer for a select or radio, several for checkboxes.
    for (const each of field.type === "checkboxes" ? values : [value]) {
      if (!rules.options.includes(each)) return [field.type === "checkboxes" ? `${each} isn't one of the choices` : "isn't one of the choices"];
    }
  }
  return [];
}

function requiredMessage(type: string): string {
  if (type === "checkbox") return "must be ticked";
  if (type === "checkboxes" || type === "radio" || type === "select") return "choose one";
  return "can't be blank";
}

function fileProblem(rules: FieldRules, file: PostedFile): string | null {
  const limit = rules.max_mb ?? 5;
  if (file.size > limit * 1024 * 1024) return `is larger than ${format(limit)} MB`;
  if (rules.accept?.length) {
    const ext = /\.[^./\\]+$/.exec(file.name.toLowerCase())?.[0] ?? "";
    const type = file.type.toLowerCase();
    const ok = rules.accept.some((raw) => {
      const accept = raw.trim().toLowerCase();
      return accept === ext || accept === type || (accept.endsWith("/*") && type.startsWith(accept.slice(0, -1)));
    });
    if (!ok) return `isn't an allowed type (${rules.accept.join(", ")})`;
  }
  return null;
}

const compiled = new Map<string, RegExp>();
function compile(pattern: string): RegExp {
  let regexp = compiled.get(pattern);
  if (!regexp) compiled.set(pattern, (regexp = new RegExp(pattern)));
  return regexp;
}

// Go's %g: 100, 0.5, 1e+06 — the integers a form uses print plainly.
function format(n: number): string {
  return String(n);
}

/** The values and files of a <form>'s FormData, as `validate` takes them. */
export function postedFrom(data: { entries(): IterableIterator<[string, unknown]> }): Posted {
  const posted: Required<Posted> = { values: {}, files: {} };
  for (const [rawName, value] of data.entries()) {
    const name = rawName.endsWith("[]") ? rawName.slice(0, -2) : rawName;
    if (typeof value === "string") (posted.values[name] ??= []).push(value);
    else if (value && typeof value === "object" && "size" in value) (posted.files[name] ??= []).push(value as PostedFile);
  }
  return posted;
}

/** The server's message for a field as a sentence: "Email isn't an email address." */
export function sentence(label: string, message: string): string {
  const text = label ? `${label} ${message}` : message;
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}${/[.!?]$/.test(text) ? "" : "."}`;
}
