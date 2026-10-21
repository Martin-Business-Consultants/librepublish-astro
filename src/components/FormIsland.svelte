<!--
  A form built in the CMS, drawn in the browser from its live definition: the
  island a fully static site uses where it can't render <Form> on demand. The
  page stays prerendered, and an edit to the form in the CMS shows without a
  build.

    <FormIsland client:load slug="contact" cms="https://cms.example" />

  (StaticForm.astro renders it with the CMS's address from the build, and a
  notice for a visitor without JavaScript.)

  It reads GET <cms>/api/x/forms/definition?form=<slug> (public, CORS: the
  site's origin must be allowed in Settings › General), draws it with the
  same markup, classes and data-state as <Form>, checks it with the same
  validator (@librepublish/astro/forms/rules), and posts it as JSON to the
  definition's `action`. Until the definition comes the form's data-state is
  "loading"; if the CMS can't be reached it's "unavailable", a message says
  so, and no form is drawn.

  Its own design, where a site needs one:

  - a field drawn by the site: `renderers={{ service_type: snippet }}` (from
    Svelte), or a slot named `field-<name>` (from Astro). The island draws the
    field's wrapper, help and error around it; the site's controls only need
    the field's name. Hidden by its show_if, their controls are disabled.
  - slots `before` and `after` (the fields), and `classes` added beside the
    cms-form__* ones;
  - `beforeSubmit(values, context)`, after the CMS's rules pass: add or change
    values, or answer false (stop) or { field: [message] } (stop, and show
    them). The `cms-form:before-submit` event does the same from a page's
    script (`detail.values`, `detail.waitUntil(promise)`, preventDefault()).
  - `onsubmitted`, `onerror` and `onready`, and the same as events on the
    <form> (cms-form:submitted, cms-form:error, cms-form:ready), which bubble.
    After a post the CMS sent elsewhere (the form's thank-you page, a hook's
    redirect), `onsubmitted` returning false or the event's preventDefault()
    keeps the visitor on the page.
-->
<script lang="ts">
  import { onMount, tick, type Snippet } from "svelte";
  import { clientRules, defaultValues, fetchDefinition, jsonBody, MESSAGES, submit, type Outcome } from "@librepublish/astro/forms/browser";
  import { postedFrom, sentence, shown, validate, type FieldErrors } from "@librepublish/astro/forms/rules";
  import type { FormDefinition, FormField } from "@librepublish/astro/forms";

  /** What a renderer (or slot) is handed to draw a field. */
  interface FieldContext {
    field: FormField;
    /** The control's id, which the island's label and error refer to. */
    id: string;
    required: boolean;
    /** The help's and error's ids, for aria-describedby. */
    describedBy: string;
    /** Hidden by its show_if: the island disables the field's controls. */
    hidden: boolean;
    /** The field's error, as a sentence ("" when there's none). */
    error: string;
  }
  /** A check's verdict: nothing or true carries on, false stops, errors stop and are shown beside their fields. */
  type Verdict = void | undefined | boolean | FieldErrors;
  interface Context { slug: string; definition: FormDefinition; form: HTMLFormElement }
  type Classes = Partial<Record<"form" | "fields" | "field" | "label" | "control" | "help" | "error" | "submit" | "status", string>>;

  interface Props {
    slug: string;
    /** The CMS's address (StaticForm passes the build's). */
    cms: string;
    /** The form's id when a page has it more than once; cms-form-<slug> by default. */
    id?: string;
    class?: string;
    classes?: Classes;
    /** Fields the site draws itself, by name. */
    renderers?: Record<string, Snippet<[FieldContext]>>;
    before?: Snippet;
    after?: Snippet;
    beforeSubmit?: (values: Record<string, unknown>, context: Context) => Verdict | Promise<Verdict>;
    /** Sent, before the visitor goes to `redirect` (absolute, or ""); return false to stay on the page. */
    onsubmitted?: (detail: { slug: string; values: Record<string, unknown>; outcome: Outcome & { ok: true }; redirect: string }) => void | boolean;
    onerror?: (detail: { slug: string; status: number; message: string; errors: FieldErrors }) => void;
    onready?: (detail: { slug: string; definition: FormDefinition }) => void;
    [slot: string]: unknown;
  }

  let { slug, cms, id: givenId, class: className, classes = {}, renderers = {}, before, after, beforeSubmit, onsubmitted, onerror, onready, ...slots }: Props = $props();

  const id = $derived(givenId || `cms-form-${slug}`);
  let definition = $state<FormDefinition | null>(null);
  let phase = $state<"loading" | "unavailable" | "idle" | "sending" | "sent" | "failed">("loading");
  let status = $state("");
  let errors = $state<FieldErrors>({});
  let visible = $state(new Set<string>());
  let loadedAt = $state("");
  let form = $state<HTMLFormElement | null>(null);
  let shell = $state<HTMLElement | null>(null);
  let captchaBox = $state<HTMLElement | null>(null);

  const config = $derived(definition ? clientRules(definition) : null);
  const labels = $derived(new Map((config?.fields ?? []).map((field) => [field.name, field.label])));
  const honeypot = $derived(definition?.spam.honeypot_field || "_hp");
  const timestamp = $derived(definition?.spam.timestamp_field || "_ts");

  const fieldId = (field: FormField) => `${id}-${field.name}`;
  const required = (field: FormField) => field.rules?.required ?? field.required ?? false;
  const maxLength = (field: FormField) => field.rules?.max_length ?? (field.max_length || undefined);
  const min = (field: FormField) => field.rules?.min ?? field.min;
  const max = (field: FormField) => field.rules?.max ?? field.max;
  const describedBy = (field: FormField) => [field.help ? `${fieldId(field)}-help` : null, `${fieldId(field)}-error`].filter(Boolean).join(" ");
  const ticked = (field: FormField) => field.default === "yes" || field.default === "true";
  const isHidden = (field: FormField) => Boolean(field.name) && !visible.has(field.name);
  const errorText = (name: string) => (errors[name] ?? []).map((message) => (name === "captcha" ? message : sentence(labels.get(name) ?? name, message))).join(" ");
  const custom = (field: FormField) => renderers[field.name] ?? (slots[`field-${field.name}`] as Snippet<[FieldContext]> | undefined);
  const context = (field: FormField): FieldContext => ({ field, id: fieldId(field), required: required(field), describedBy: describedBy(field), hidden: isHidden(field), error: errorText(field.name) });
  const autocomplete: Record<string, string> = { email: "email", tel: "tel", url: "url" };
  const cls = (base: string, hook?: string) => (hook ? `${base} ${hook}` : base);

  function emit(name: string, detail: object, cancelable = false) {
    const event = new CustomEvent(`cms-form:${name}`, { detail, bubbles: true, cancelable });
    (form ?? shell)?.dispatchEvent(event);
    return event;
  }

  onMount(async () => {
    try {
      definition = await fetchDefinition(cms, slug);
    } catch {
      phase = "unavailable";
      status = MESSAGES.unavailable;
      onerror?.({ slug, status: 0, message: status, errors: {} });
      emit("error", { slug, status: 0, message: status, errors: {} });
      return;
    }
    visible = shown(clientRules(definition).fields, { values: defaultValues(definition.fields) });
    loadedAt = String(Date.now());
    phase = "idle";
    await tick();
    loadCaptcha();
    onready?.({ slug, definition });
    emit("ready", { slug, definition });
  });

  // What's entered now, as the rules read it.
  const posted = () => postedFrom(new FormData(form!) as unknown as { entries(): IterableIterator<[string, unknown]> });

  // Fields shown only for some answers: shown and enabled as they're given,
  // hidden and disabled (so not posted) as they're taken back. A condition
  // names an earlier field, so one pass in order settles it.
  function toggle() {
    if (!form || !config?.fields.some((field) => field.show_if)) return;
    visible = shown(config.fields, posted());
  }
  // A hidden field's controls are disabled, the site's own too, so they aren't posted.
  $effect(() => {
    const on = visible;
    form?.querySelectorAll<HTMLElement>("[data-field]").forEach((wrapper) => {
      const off = Boolean(wrapper.dataset.field) && !on.has(wrapper.dataset.field!);
      wrapper.querySelectorAll<HTMLInputElement>("input, select, textarea").forEach((control) => { control.disabled = off; });
    });
  });

  function clear() {
    errors = {};
    form?.querySelectorAll("[aria-invalid]").forEach((el) => el.removeAttribute("aria-invalid"));
  }
  async function show(found: FieldErrors) {
    errors = found;
    await tick();
    let first: HTMLElement | null = null;
    const loose: string[] = [];
    for (const [name, messages] of Object.entries(found)) {
      const input = form?.querySelector<HTMLElement>(`[name="${CSS.escape(name)}"]`) ?? null;
      input?.setAttribute("aria-invalid", "true");
      first ??= input;
      // A name with no field (a site's own check): said with the status.
      if (name !== "captcha" && !labels.has(name)) loose.push(...messages);
    }
    first?.focus();
    return loose;
  }

  function loadCaptcha() {
    const captcha = definition?.spam.captcha;
    if (!captcha || !captchaBox) return;
    const w = window as unknown as { turnstile?: { render(el: HTMLElement, o: object): void }; grecaptcha?: { render?(el: HTMLElement, o: object): void } };
    const api = captcha.provider === "turnstile" ? w.turnstile : w.grecaptcha;
    if (api?.render) { api.render(captchaBox, { sitekey: captcha.site_key }); return; }
    // The script draws every widget on the page when it loads.
    if (document.querySelector(`script[src="${CSS.escape(captcha.script)}"]`)) return;
    const script = document.createElement("script");
    script.src = captcha.script;
    script.async = true;
    script.defer = true;
    document.head.append(script);
  }
  function resetCaptcha() {
    const w = window as unknown as { turnstile?: { reset(): void }; grecaptcha?: { reset(): void } };
    try { w.turnstile?.reset(); w.grecaptcha?.reset(); } catch { /* not loaded */ }
  }

  /** Every check's verdict, as one: errors shown, or a stop, or on. */
  function verdictOf(verdicts: Verdict[]): { stop: boolean; errors: FieldErrors } {
    const found: FieldErrors = {};
    let stop = false;
    for (const verdict of verdicts) {
      if (verdict === false) stop = true;
      else if (verdict && typeof verdict === "object") for (const [name, messages] of Object.entries(verdict)) (found[name] ??= []).push(...messages);
    }
    return { stop: stop || Object.keys(found).length > 0, errors: found };
  }

  function failed(outcome: { status: number; message: string; errors: FieldErrors }) {
    phase = "failed";
    onerror?.({ slug, ...outcome });
    emit("error", { slug, ...outcome });
  }

  async function onsubmit(event: SubmitEvent) {
    event.preventDefault();
    if (!form || !definition || !config || phase === "sending") return;
    clear();
    const data = new FormData(form);
    const entered = posted();
    const invalid = validate(config.fields, entered);
    if (Object.keys(invalid).length) {
      status = MESSAGES.invalid;
      await show(invalid);
      failed({ status: 422, message: status, errors: invalid });
      return;
    }

    const values = await jsonBody(config.fields, data.entries() as Iterable<[string, unknown]>, shown(config.fields, entered));
    // The site's own checks: the callback's, and the page's (cms-form:before-submit).
    const waits: Promise<Verdict>[] = [];
    try {
      waits.push(Promise.resolve(beforeSubmit?.(values, { slug, definition, form })));
      const asked = emit("before-submit", { slug, definition, values, waitUntil: (promise: Promise<Verdict>) => waits.push(Promise.resolve(promise)) }, true);
      const verdict = verdictOf([...(await Promise.all(waits)), asked.defaultPrevented ? false : undefined]);
      if (verdict.stop) {
        if (!Object.keys(verdict.errors).length) { phase = "idle"; status = ""; return; }
        const loose = await show(verdict.errors);
        status = [MESSAGES.invalid, ...loose.map((message) => sentence("", message))].join(" ");
        failed({ status: 422, message: status, errors: verdict.errors });
        return;
      }
    } catch (error) {
      status = MESSAGES.failed;
      failed({ status: 0, message: (error as Error).message || status, errors: {} });
      return;
    }

    phase = "sending";
    status = MESSAGES.sending;
    const outcome = await submit(definition.action, values, { success: config.success });
    if (outcome.ok) {
      const redirect = outcome.redirect ? new URL(outcome.redirect, window.location.href).href : "";
      const stay = onsubmitted?.({ slug, values, outcome, redirect }) === false;
      // Cancelable: a page's script can keep the visitor here (and go there itself).
      const sent = emit("submitted", { slug, values, outcome, redirect }, true);
      if (redirect && !stay && !sent.defaultPrevented) { window.location.assign(redirect); return; }
      phase = "sent";
      status = outcome.message;
      form.reset();
      loadedAt = String(Date.now());
      visible = shown(config.fields, { values: defaultValues(definition.fields) });
      resetCaptcha();
      return;
    }
    status = outcome.message;
    await show(outcome.errors);
    resetCaptcha();
    failed(outcome);
  }
</script>

{#if phase === "loading" || phase === "unavailable" || !definition}
  <div bind:this={shell} class={["cms-form", className, classes.form]} id={id} data-cms-form-island={slug} data-state={phase} aria-busy={phase === "loading"}>
    {#if phase === "unavailable"}
      <p class={cls("cms-form__unavailable", classes.status)} role="alert">{status}</p>
    {:else}
      <p class={cls("cms-form__loading", classes.status)} role="status">Loading the form…</p>
    {/if}
  </div>
{:else}
  <form
    bind:this={form}
    id={id}
    class={["cms-form", className, classes.form]}
    action={definition.action}
    method="post"
    novalidate
    data-cms-form-island={definition.slug}
    data-state={phase}
    {onsubmit}
    oninput={toggle}
    onchange={toggle}
  >
    {#if !definition.open}
      <p class="cms-form__closed">{MESSAGES.closed}</p>
    {:else}
      {@render before?.()}
      <div class={cls("cms-form__fields", classes.fields)}>
        {#each definition.fields as field, index (field.name || `heading-${index}`)}
          {@const fid = fieldId(field)}
          {@const own = custom(field)}
          {#if field.type === "heading"}
            <h3 class="cms-form__heading">{field.text || field.label}</h3>
          {:else if field.type === "hidden" && !own}
            <input type="hidden" name={field.name} defaultValue={field.default ?? ""} />
          {:else}
            <div
              class={["cms-form__field", `cms-form__field--${field.type}`, field.width === "half" ? "cms-form__field--half" : "cms-form__field--full", classes.field]}
              data-field={field.name}
              data-show-if={field.show_if ? "" : undefined}
              hidden={isHidden(field)}
            >
              {#if own}
                {@render own(context(field))}
              {:else if field.type === "checkbox"}
                <label for={fid} class={cls("cms-form__check", classes.label)}>
                  <input id={fid} class={classes.control} type="checkbox" name={field.name} value="yes" required={required(field)} defaultChecked={ticked(field)} aria-describedby={describedBy(field)} />
                  {" "}{field.text || field.label}{#if required(field)}<span class="cms-form__required" aria-hidden="true"> *</span>{/if}
                </label>
              {:else if field.type === "radio" || field.type === "checkboxes"}
                <fieldset class="cms-form__choices" aria-describedby={describedBy(field)}>
                  <legend class={classes.label}>{field.label}{#if required(field)}<span class="cms-form__required" aria-hidden="true"> *</span>{/if}</legend>
                  {#each field.options ?? [] as option, i (option)}
                    <label class="cms-form__check">
                      <input
                        class={classes.control}
                        type={field.type === "radio" ? "radio" : "checkbox"}
                        name={field.name}
                        value={option}
                        required={field.type === "radio" && required(field) && i === 0}
                        defaultChecked={field.default === option}
                      />
                      {" "}{option}
                    </label>
                  {/each}
                </fieldset>
              {:else}
                <label for={fid} class={classes.label}>{field.label}{#if required(field)}<span class="cms-form__required" aria-hidden="true"> *</span>{/if}</label>
                {#if field.type === "textarea"}
                  <textarea id={fid} class={classes.control} name={field.name} rows={field.rows || 5} required={required(field)} maxlength={maxLength(field)} placeholder={field.placeholder} aria-describedby={describedBy(field)} defaultValue={field.default ?? ""}></textarea>
                {:else if field.type === "select"}
                  <select id={fid} class={classes.control} name={field.name} required={required(field)} aria-describedby={describedBy(field)}>
                    <option value="">{field.placeholder || "Choose…"}</option>
                    {#each field.options ?? [] as option (option)}
                      <option value={option} selected={field.default === option}>{option}</option>
                    {/each}
                  </select>
                {:else if field.type === "file"}
                  <input id={fid} class={classes.control} type="file" name={field.name} required={required(field)} accept={field.rules?.accept?.join(",") ?? field.accept} aria-describedby={describedBy(field)} />
                {:else}
                  <input
                    id={fid}
                    class={classes.control}
                    type={field.type}
                    name={field.name}
                    defaultValue={field.default ?? ""}
                    required={required(field)}
                    placeholder={field.placeholder}
                    maxlength={field.type === "number" || field.type === "date" ? undefined : maxLength(field)}
                    min={field.type === "number" ? min(field) : undefined}
                    max={field.type === "number" ? max(field) : undefined}
                    step={field.type === "number" ? "any" : undefined}
                    pattern={field.type === "email" || field.type === "tel" || field.type === "url" ? field.rules?.pattern : undefined}
                    autocomplete={autocomplete[field.type] as "email" | undefined}
                    aria-describedby={describedBy(field)}
                  />
                {/if}
              {/if}
              {#if field.help}<p class={cls("cms-form__help", classes.help)} id={`${fid}-help`}>{field.help}</p>{/if}
              <p class={cls("cms-form__error", classes.error)} id={`${fid}-error`} data-error-for={field.name} hidden={!errors[field.name]}>{errorText(field.name)}</p>
            </div>
          {/if}
        {/each}
      </div>
      {@render after?.()}

      <div class="cms-form__honeypot" aria-hidden="true">
        <label>Leave this empty <input type="text" name={honeypot} value="" tabindex="-1" autocomplete="off" /></label>
      </div>
      <input type="hidden" name={timestamp} value={loadedAt} data-cms-ts />

      {#if definition.spam.captcha}
        <div class="cms-form__captcha">
          <div bind:this={captchaBox} class={definition.spam.captcha.provider === "turnstile" ? "cf-turnstile" : "g-recaptcha"} data-sitekey={definition.spam.captcha.site_key}></div>
          <p class={cls("cms-form__error", classes.error)} data-error-for="captcha" hidden={!errors.captcha}>{errorText("captcha")}</p>
        </div>
      {/if}

      <button type="submit" class={cls("cms-form__submit", classes.submit)} disabled={phase === "sending"}>{definition.submit_label || "Send"}</button>
    {/if}
    <p class={cls("cms-form__status", classes.status)} role="status" aria-live="polite">{status}</p>
  </form>
{/if}

<style>
  :where(.cms-form__fields) { display: flex; flex-wrap: wrap; gap: 1rem; }
  :where(.cms-form__field, .cms-form__heading) { flex: 1 1 100%; min-width: 0; }
  :where(.cms-form__field--half) { flex: 1 1 calc(50% - 0.5rem); }
  :where(.cms-form__honeypot) { position: absolute; left: -9999px; width: 1px; height: 1px; overflow: hidden; }
  /* A field its condition hides stays hidden whatever display the site gives fields. */
  :global(.cms-form__field[hidden]) { display: none !important; }
</style>
