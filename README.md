# LibrePublish CMS for Astro

`@librepublish/astro` is the whole Astro integration for
[LibrePublish CMS](https://github.com/Martin-Business-Consultants/librepublishgo),
in one package. It lives beside the CMS (this repository's Go core) and is
written against its APIs, so the two move together:

- **Content, held to the CMS's schema.** Content loaders whose schema is the
  CMS's own (JSON Schema made into Zod), so a record the schema doesn't
  describe fails the build; types generated from the same schema; live
  collections for on-demand pages, checked the same way.
- **A schema lock.** `cms.lock.json` pins the schema the site was written
  against. When the CMS's schema moves, `astro build` and `astro check` stop
  and say what changed, until you run `npx librepublish-astro sync`.
- **Rendering.** `<Blocks>` (a component for every block type, enforced),
  `<Image>` (the CMS's renditions as a srcset, with the focal point),
  `<RichText>` (the CMS's Markdown as safe HTML), `<BrandStyles>` (Settings ›
  Brand as CSS custom properties), `<Seo>`, `linkHref` and
  `recordPath`.
- **Forms.** `<Form slug="…"/>` draws a form built in the CMS from its live
  definition on every request — every field type, its rules checked in the
  browser by one generic validator, errors from the CMS beside each field,
  and it still works without JavaScript. A fully static site draws the same
  form in the browser instead (`<StaticForm>`, a Svelte island).
- **Site files.** `/sitemap.xml`, `/robots.txt` and Cloudflare `_redirects`,
  all from the CMS. Redirects live in the CMS and nowhere else.
- **Publishing.** A static site is rebuilt when content is published. An
  on-demand site gets a signed purge at `/_cms/webhook` instead, and every
  response carries a `Cache-Tag`.
- **Build checks.** Site health is checked on every build, and each build
  reports to the CMS.

It reads the delivery API (`/api/v1`, librepublishgo's [docs/delivery-api.md](https://github.com/Martin-Business-Consultants/librepublishgo/blob/main/docs/delivery-api.md)), which only
serves live content, always answers in one shape, and gives absolute asset
URLs. Astro 7.4+ and the Go core are required; it's built for Cloudflare
Workers & Pages and runs on any adapter.

## Install

```sh
# Not on npm yet: from GitHub, pinned to a commit or tag (`prepare` builds it)
npm install github:Martin-Business-Consultants/librepublish-astro#<commit>
# or from a checkout of this repository:
npm install /path/to/librepublish-astro
```

With pnpm, let it build: in `pnpm-workspace.yaml`,

```yaml
allowBuilds:
  '@librepublish/astro@https://codeload.github.com/Martin-Business-Consultants/librepublish-astro/tar.gz/<commit>': true
```

`.env` (keep it out of git):

```sh
CMS_BASE_URL=https://cms.example.com
CMS_API_TOKEN=…          # a service token on the "Production site" role (librepublish token create)
```

`astro.config.mjs`:

```js
import { defineConfig } from "astro/config";
import cloudflare from "@astrojs/cloudflare";
import cms from "@librepublish/astro";

export default defineConfig({
  // An adapter lets pages render on demand: <Form> needs one.
  adapter: cloudflare({ prerenderEnvironment: "node" }),
  integrations: [cms()],
});
```

`src/content.config.ts` — no `schema` of your own: each loader brings the CMS's.

```ts
import { defineCollection } from "astro:content";
import { cmsAssets, cmsEntries, cmsGlobals, cmsPages } from "@librepublish/astro/loaders";

export const collections = {
  pages: defineCollection({ loader: cmsPages() }),
  posts: defineCollection({ loader: cmsEntries("posts") }),   // one per collection the site shows
  globals: defineCollection({ loader: cmsGlobals() }),
  assets: defineCollection({ loader: cmsAssets() }),
};
```

Then pin the schema and check the site against it:

```sh
npx librepublish-astro sync    # writes cms.lock.json
npx astro check                # the generated types follow the schema
git add cms.lock.json
```

## The schema lock

`cms.lock.json` records the CMS schema the site is written against: its
digest (`meta.schema_digest`: `sha256:` of the canonical JSON of `GET
/api/v1/schema`'s `data`), a digest for each block type, collection, global,
page with fields and SEO (so a mismatch can say what changed), the CMS's URL,
API version and `cms_version`, and each form's digest for reference. Commit it.

| Command | Lock matches | Lock differs (or is missing) |
|---|---|---|
| `astro build` | builds | **fails**, listing `+ added`, `- removed`, `~ changed` parts |
| `astro check`, `astro sync` | checks | **fails**, the same way |
| `astro dev` | runs | warns, rewrites the lock and runs on the new schema |
| `npx librepublish-astro sync` | refreshes the lock | rewrites the lock, prints what changed |
| `npx librepublish-astro check` | exit 0 | exit 1, prints what changed |
| any, with `LIBREPUBLISH_ACCEPT_SCHEMA=1` | — | rewrites the lock and goes on |

The workflow when someone changes a block type, collection or global in the
CMS: run `npx librepublish-astro sync`, then `astro check` — the types now
follow the new schema, so it names every component and page to change —
fix them, commit the lock with the fixes. `astro dev` restarts when the lock
changes.

For CI that keeps the site in step automatically: subscribe a webhook to
`schema.changed` (the CMS sends `{ "schema_digest": "sha256:…" }`) and have it
run a job with `LIBREPUBLISH_ACCEPT_SCHEMA=1 npx astro build` that opens a pull
request with the new `cms.lock.json`. The pull request's own `astro check`
then fails until the site handles the change.

## What's enforced

- **Every record matches the schema.** Each loader's `createSchema()` turns
  the locked schema into Zod, and Astro runs every record through it:
  - objects with `additionalProperties: false` (block data, frontmatter,
    global data, SEO, groups and repeater items — the CMS closes them all and
    delivers only the keys they declare) are strict: an unknown key fails;
  - a required field must hold a value (not null, `""` or `[]`, as the CMS's
    own validator has it); an optional one may be missing or null, and `""`
    reads as null for anything but text;
  - `x-cms-type` adds what JSON Schema can't say: a link's shape (an entry
    link needs its collection), safe URLs, RFC 3339 datetimes, and `blocks`
    as a union discriminated by block type, each with its own data schema,
    nested as deep as the CMS nests them; `oneOf` is a union (SEO's
    `json_ld`: one node or a list);
  - the records around the fields (page, entry, global, asset, block) are
    strict too: a key the CMS starts sending that this package doesn't know
    fails, rather than slip by.

  A failure names the record and the field. When the schema or the CMS
  changes, every record is read and checked again, not just what changed.
- **The build runs on one schema.** Every `/api/v1` answer carries
  `X-CMS-Schema-Digest`; one that differs from the lock during a build stops it.
- **Every block type has a component.** `<Blocks components={…}>` is typed
  `BlockComponents`: a block type left out, or one the CMS doesn't have, is a
  type error, and each component's props are checked against its block's
  data. At build time, content using a block type with no component stops
  the build. Synced patterns arrive expanded into their blocks (the schema
  has no `pattern` block type), so there's no component to write for them.
- **Type generation is fatal in a build.** If the types can't be generated,
  `astro build` and `astro check` stop.
- **Forms can't go stale.** `<Form>` on a prerendered page stops the build.
- **Redirects live in the CMS (Tools › Redirects), and only there.** After a
  build, `_redirects` holds the CMS's rules and nothing else. A site that
  defines its own stops the build: a `redirects` map in `astro.config`, or
  rules in `public/_redirects` (comments are fine). Two places to keep a
  redirect means one goes stale, and the CMS is the one editors can see — so
  a renamed URL, a retired page or a withheld one is a CMS redirect, never a
  line in the repo.
- **Pages rendered on demand** compare the digest the CMS sends with the one
  they were built with; a mismatch is logged once and the response carries
  `X-CMS-Schema-Stale`. Live collections check each record against the
  schema as the CMS has it now, and answer an error instead of rendering one
  that doesn't fit.

## Pages

Serve each record where the CMS says it lives: `/` for the home page (path
`home`), `/fr/…` for French, `/<collection>/<slug>` for an entry. `routeParam` also
handles an SEO canonical, which can be an absolute URL:

```astro
---
import { getCollection } from "astro:content";
import Blocks from "@librepublish/astro/components/Blocks.astro";
import Seo from "@librepublish/astro/components/Seo.astro";
import { routeParam } from "@librepublish/astro/client";
import { components } from "../components/blocks";

export async function getStaticPaths() {
  return (await getCollection("pages")).map(({ data: page }) => ({
    params: { path: routeParam(page, { site: import.meta.env.SITE }) },
    props: { page },
  }));
}
const { page } = Astro.props;                 // typed: Page, from the CMS's schema
const assets = Object.fromEntries((await getCollection("assets")).map((a) => [a.id, a.data]));
---
<html lang={page.locale}>
  <head><Seo record={page} assets={assets} siteName="Acme" /></head>
  <body><Blocks blocks={page.blocks} components={components} assets={assets} /></body>
</html>
```

```ts
// src/components/blocks/index.ts
import type { BlockComponents } from "librepublish:types";
import Hero from "./Hero.astro";
// …
export const components = { hero: Hero, text: Text, /* every block type */ } satisfies BlockComponents;
```

```astro
---
// src/components/blocks/Hero.astro
import type { BlockProps } from "librepublish:types";
type Props = BlockProps<"hero">;              // the hero's data, plus block, resolved, assets
const { heading, image_id, assets } = Astro.props;
---
```

- **Blocks.** Each component gets its block's `data` as props, plus `block`,
  `assets` and `resolved` — what the CMS filled in: a `collection_list` gets
  its entries, `contact_info` the contact details. A `blocks` field holds
  blocks of the same shape: render them with another `<Blocks>`.
- **Images.** `<Image asset={assets[id]} sizes="…" />` serves the asset from
  the CMS with its renditions (at the widths `GET /api/v1/site`'s
  `image_widths` names, which also become Astro's `image.breakpoints`), size,
  alt text and focal point. The CMS's file host is added to
  `image.remotePatterns`.
- **Types.** `import type { Page, Entries, Globals, Block, BlockProps, BlockComponents, AssetId, Link } from "librepublish:types"`,
  regenerated on every `astro dev`, `astro sync` and `astro build`. An
  optional field is `T | null`. Asset ids and record refs are branded strings
  (`AssetId`, `RecordRef`).
- **Field values.** `markdown` fields (and `body_markdown`) are Markdown:
  draw them with `<RichText>` (below). `string` and `text` fields are plain
  text. Link fields go through `linkHref(link)`.

## Rich text

A `richtext` field is the CMS's rich text: written in the admin's editor
(Tiptap) and stored as the editor's own document, Tiptap JSON, which the
site turns into HTML. `<RichText>` and `renderRichText()` draw it: every
piece of text escaped, only the editor's nodes and marks, links only to
http(s), mailto:, tel: or a path. They draw a `markdown` field (and an
entry's `body_markdown`) the same way. Plain text fields stay plain, and the
CMS refuses HTML typed into them (librepublishgo's docs/delivery-api.md, "Text and rich
text"), so formatting lives in one place.

```astro
---
import RichText from "@librepublish/astro/components/RichText.astro";
// A block with a string field (heading) and two markdown fields (intro, body).
const { heading, intro, body } = Astro.props;
---
<h2>{heading}</h2>                                     <!-- plain text: as text -->
<p class="lead"><RichText value={intro} inline /></p>  <!-- no <p> of its own -->
<RichText value={body} class="prose" rel="noopener noreferrer" target="_blank" />
```

| Prop | |
|---|---|
| `value` | The Markdown (`string \| null \| undefined`); nothing is drawn for none. |
| `class` | Wraps the HTML in a `<div>` (a `<span>` when `inline`) with this class; without it the HTML is placed as is. |
| `inline` | One paragraph's worth without its `<p>`, for inside a heading or a paragraph. |
| `rel`, `target` | Put on links to other sites (absolute `http(s)` addresses). |

`renderRichText(markdown, { inline, rel, target })` from
`@librepublish/astro/rich-text` returns the same HTML as a string (for an
RSS feed, say). It renders what the editor writes — paragraphs, headings,
bold, italic, strikethrough, links, bullet, numbered and task lists (nested
too), quotes, code and code blocks, rules, and line breaks — and it's safe on
any input: HTML in the Markdown is escaped, never passed through, and a link
goes only to `http(s)`, `mailto:`, `tel:` or a path (`javascript:` and the
like stay text). Images and tables, which the editor doesn't write, stay
text too. It's [markdown-it](https://github.com/markdown-it/markdown-it)
with raw HTML off: CommonMark, maintained, and no DOM needed, so it runs at
build time and on Workers alike.

Generated types keep `markdown` fields as `string`, with a
`/** … CMS Markdown: render with <RichText> */` note on each.

## Branding

Settings › Brand in the CMS is the site's visual identity: a logo and a
favicon, a primary and a secondary color, a font, corners and a shadow.
`GET /api/v1/site` carries it as `data.branding` (`CmsBranding`), with only
what's set: `logo` and `favicon` are asset objects (`url`, `width`,
`height`, `alt`, `srcset`…), the rest plain values.

`<BrandStyles />` puts it into CSS as custom properties on `:root`, for the
site's own CSS to read:

```astro
---
import BrandStyles from "@librepublish/astro/components/BrandStyles.astro";
import { runtimeClient } from "@librepublish/astro/runtime/env";
const site = (await runtimeClient().site()).data;
---
<head>
  <BrandStyles site={site} loadFont />
  {site.branding.favicon && <link rel="icon" href={site.branding.favicon.url} />}
  <style is:global>
    body { font-family: var(--brand-font, system-ui, sans-serif); }
    .button { background: var(--brand-primary); color: var(--brand-on-primary); border-radius: var(--brand-radius); box-shadow: var(--brand-shadow); }
  </style>
</head>
```

| Property | From |
|---|---|
| `--brand-primary` | `primary_color`, as `#rrggbb`. |
| `--brand-on-primary` | Text that reads on it: `#ffffff`, or `#1c1917` on a light primary. |
| `--brand-secondary` | `secondary_color`. |
| `--brand-font` | `font`, then a fallback stack of its kind (sans or serif). |
| `--brand-radius` | `border_radius`: `0`, `0.25rem`, `0.5rem` or `0.875rem`. |
| `--brand-shadow` | `box_shadow`: `none` or a shadow, small to large. |

Only what's set is written, and nothing at all when nothing is. The CMS
checks every value when it's saved and when it's delivered; this checks
them again, because they go into CSS: colors must be hex, the font, corners
and shadow one of the CMS's names, and nothing from the API is placed into
the CSS as it came — the values are rebuilt from the checked hex digits and
the integration's own tables. Props: `site` (or `branding`), `loadFont`
(also link the font from Google Fonts; off by default, for a site that
hosts its fonts), `selector` (default `:root`).

`brandingCss(site, { selector })`, `brandingFontHref(site)` and
`checkedBranding(site)` from `@librepublish/astro/branding` do the same as
functions.

## Forms

A form is built in the CMS (Content › Forms) and drawn from its live
definition on every request, so the site never holds a copy that can go
stale. `<Form>` renders on demand only — on a prerendered page it stops the
build — so the site needs an adapter, and the page opts out of prerendering:

```astro
---
import Form from "@librepublish/astro/components/Form.astro";
export const prerender = false;
---
<Form slug="contact" />
```

- **Every field type** the CMS's builder has: text, email, tel, url, number
  and date inputs, textarea, select, radio, checkboxes, a consent checkbox,
  file, hidden and heading — with each field's width (half or full), rows,
  min/max, max length, accept, choices, default, placeholder and help.
- **Spam checks**: an empty honeypot (`_hp`) and the time the page loaded
  (`_ts`) are always sent; the CMS's captcha (Turnstile or reCAPTCHA) is drawn
  and its script loaded when the form has one.
- **Checked in the browser by the CMS's rules.** Each field in the definition
  declares its `rules` (required, max length, min/max, a pattern, accept, max
  size, choices); one generic validator
  (`@librepublish/astro/forms/rules`) applies them, in the CMS's own words,
  and is as strict as the server where a pattern can't be: a real calendar
  date, a URL that parses, a number that doesn't overflow. It reaches the
  server's verdict on the contract's recorded submissions. The CMS stays the
  authority: its 422 answer lands beside each field.
- **Without JavaScript** the browser posts the form, and the CMS sends the
  visitor back to the page (`_return`, which `<Form>` fills in; honored on the
  site's origins) with `?form=<slug>&form_status=sent|error` (shown by
  `<Form>`), or to the form's thank-you page. `_return`, `_hp`, `_ts` and
  `form` are reserved: the CMS won't let a field take those names.
- **A closed form** says it isn't taking submissions (the CMS answers a post
  `410`).
- **Fields shown only for some answers** (the builder's "Show only when",
  `show_if` in the definition): drawn hidden and disabled until the answers
  that show them are given, and shown as they are. Hidden, a field isn't
  checked or posted, as the CMS has it.
- **`id`** names the form when the page has it more than once
  (`<Form slug="quote" id="quote-mobile" />`); `cms-form-<slug>` by default.
- There are no field components to build a form by hand: change a form in
  the CMS, not in the site.

The browser posts straight to the CMS, so the site's origin must be allowed
(Settings › General). It's unstyled beyond layout: style the `cms-form__*`
classes and the form's `data-state` (idle, sending, sent, failed). Don't cache
a page with a form at the edge.

### A form's hook

A form can hear from the site before the CMS keeps and emails a submission
(the form's Hook tab in the CMS: an address on the site and a signing
secret). The site's answer can send the visitor to another page, add values
to the submission (merge tags in its emails, columns in its CSV), or refuse
it with errors beside its fields. `formHook` is that endpoint: it checks the
CMS's signature (`CMS_FORM_HOOK_SECRET`, or `secret`) and hands the handler
the submission.

```ts
// src/pages/api/quote-hook.ts
import { answer, formHook, FormHookRefusal } from "@librepublish/astro/forms/hook";
export const prerender = false;

export const POST = formHook(async (submission) => {
  const zip = answer(submission, "zip");
  if (!(await served(zip))) throw new FormHookRefusal("We don't serve that zip yet.", { zip: ["isn't in our service area"] });
  const quote = await createQuote(submission.values);
  return { redirect: `/quote?q=${quote.id}`, values: { quote_id: quote.id } };
}, { forms: ["quote"] });
```

| Answer | The visitor |
|---|---|
| `{ redirect, message, values }` (each optional) | goes to `redirect` (a path, or an address on the site's origins), or sees `message`, instead of the form's own thank-you |
| `throw new FormHookRefusal(message, { field: [error] })` | sees the message and each error beside its field; nothing is kept |
| anything else thrown, or the site down (the CMS waits 6 s) | gets the form's own thank-you: the submission is kept and emailed as usual |

The post is `contracts/forms/form-hook-request.json`, signed like a webhook
(`X-CMS-Signature-V2` over `X-CMS-Timestamp` and the body, five minutes'
tolerance, from a CMS at 2.8.0 or later; `X-CMS-Signature: sha256=<hex
HMAC-SHA256 of the body>` from an older one).

The handler's third argument reports what it did, for the CMS's hook log and
the submission (Forms › Hook log), and says when the post is a test:

```ts
export const POST = formHook(async (submission, _context, hook) => {
  const zip = answer(submission, "zip");
  if (!(await served(zip))) {
    hook.step("Zip check", "failed", `${zip} isn't served`);
    throw new FormHookRefusal("We don't serve that zip yet.", { zip: ["isn't in our service area"] });
  }
  hook.step("Zip check", "ok", `${zip} served`);
  if (hook.test) {
    hook.step("Quote", "skipped", "Test hook: no real quote");
    return {};
  }
  const quote = await createQuote(submission.values);
  hook.step("Quote", "ok", quote.id);
  return { redirect: `/quote?q=${quote.id}`, values: { quote_id: quote.id } };
});
```

- `hook.step(label, status, detail?)`: `status` is `ok`, `failed`,
  `skipped`, `warning` or `info`. The steps go back with every answer, a
  refusal or a failure too (a throw adds a failed `Hook` step with its
  message), so the CMS sees how far it got.
- A value can be a table, a list of `{ label, value, strong? }` rows (a
  price breakdown): `values: { pricing: [{ label: "16 ft container", value:
  "$189/mo" }, { label: "Due before delivery", value: "$278", strong: true
  }] }`. An HTML email draws `{{ pricing }}` as a table; text, the CSV and
  the submission show a line a row; a webhook gets the rows.
- `hook.test`: set for **Test hook** and **Send test** in the form's Testing tab (the post's
  `"test": true`, `X-CMS-Test: 1`). Nothing is kept, so skip what a test
  shouldn't do.

## Forms on a static site

`<Form>` needs pages rendered on demand. A site that must be fully static (no
adapter, every page prerendered) draws the form in the browser instead:
`<StaticForm>` renders `<FormIsland>`, a Svelte island that reads the form's
live definition from the CMS when the page loads and posts straight to it.
The page stays static, and an edit to the form in the CMS shows without a
build. Add Svelte to the site (`npx astro add svelte`; `svelte` and
`@astrojs/svelte` are optional peer dependencies), then:

```astro
---
import StaticForm from "@librepublish/astro/components/StaticForm.astro";
---
<StaticForm slug="contact" />
```

It hydrates at once (`client:load`) with the CMS's address from the build
(the CMS's own URL, else `CMS_BASE_URL`; `cms="https://…"` overrides it), and
tells a visitor without JavaScript that the form needs it. Everything in
[Forms](#forms) holds: every field type, `show_if`, `_hp` and `_ts`, the
captcha and its script, the same validator before posting, the CMS's 422
beside each field, 410 and 429 said plainly, and the same markup,
`cms-form__*` classes and `data-state` (idle, sending, sent, failed), so a
site's form styles carry over. Two states are the island's own: `loading`
until the definition comes, and `unavailable` when the CMS can't be reached
(a message, `.cms-form__unavailable`, and no form). It posts JSON (a file as
`{filename, content_type, data}`, base64), reads the definition afresh on
each page load, and goes to the answer's `redirect` (the form's thank-you
page, or a hook's) or shows its message.

**Its own design.** A field the site draws itself goes in a slot named
`field-<name>`; the island keeps the field's wrapper (`data-field`, its
`show_if`), help and error around it, so the site's controls need only the
field's name:

```astro
<StaticForm slug="quote" classes={{ submit: "btn btn--primary", field: "row" }}>
  <div slot="field-service_type" class="pills">
    <label><input type="radio" name="service_type" value="Move It" /> Move it</label>
    <label><input type="radio" name="service_type" value="Store It" /> Store it</label>
  </div>
  <p slot="after" class="fine-print">We reply within a day.</p>
</StaticForm>
```

| | |
|---|---|
| `slug`, `cms`, `id`, `class` | The form, the CMS's address (`<FormIsland>` needs it; `<StaticForm>` has the build's), the form's id (`cms-form-<slug>`), a class on it. |
| `classes` | Classes added beside the `cms-form__*` ones: `form`, `fields`, `field`, `label`, `control`, `help`, `error`, `submit`, `status`. |
| slot `field-<name>` | That field drawn with the site's markup. Hidden by its condition, its controls are disabled. |
| slots `before`, `after` | Before and after the fields (above the submit button). |
| `cms-form:before-submit` | After the CMS's rules pass, before the post. `detail.values` is what will be posted (add or change values); `detail.waitUntil(promise)` waits for a check, whose answer is nothing (carry on), `false` (stop) or `{ field: [message] }` (stop, and show them); `preventDefault()` stops it. |
| `cms-form:submitted` | Sent: `detail.values`, `detail.outcome`, `detail.redirect` (absolute, or ""). `preventDefault()` keeps the visitor on the page. |
| `cms-form:error` | Not sent, or the form couldn't load: `detail.status` (0: never got there), `message`, `errors`. |
| `cms-form:ready` | Drawn: `detail.definition`. |

The events bubble from the form, so a page's script can listen on
`document`; a zip pre-check:

```astro
<script>
  document.addEventListener("cms-form:before-submit", (event) => {
    const { values, waitUntil } = (event as CustomEvent).detail;
    waitUntil(fetch(`/zips/${values.to_zip}.json`).then((r) => (r.ok ? undefined : { to_zip: ["isn't in our service area"] })));
  });
</script>
```

From the site's own Svelte component, `<FormIsland>` takes the same as
props: `beforeSubmit(values, { slug, definition, form })`, `onsubmitted`
(return `false` to stay on the page), `onerror`, `onready`, the `before` and
`after` snippets, and `renderers`, a snippet by field name that's handed
`{ field, id, required, describedBy, hidden, error }`:

```svelte
<script lang="ts">
  import FormIsland from "@librepublish/astro/components/FormIsland.svelte";
  let { cms } = $props();
</script>

<FormIsland slug="quote" {cms} renderers={{ service_type }} beforeSubmit={(values) => { values.landing = location.pathname; }} />

{#snippet service_type({ field, id })}
  <div class="pills" {id}>
    {#each field.options ?? [] as option}<label><input type="radio" name="service_type" value={option} /> {option}</label>{/each}
  </div>
{/snippet}
```

The page renders it as an island and hands it the CMS's address as browsers
reach it: `<QuoteForm client:load cms="https://cms.example.com" />`. A value
the CMS has no field for is dropped: give the form a hidden field for
anything a site adds.

The site's origin must be allowed (Settings › General › Allowed origins): the
browser reads the definition and posts across origins. `<Form>`'s build check
stays: `<Form>` on a prerendered page still stops the build; `<StaticForm>`
and `<FormIsland>` are meant for one.

## Pages rendered on demand

The build tells the CMS how the site renders. A **static** site (no adapter,
or every page prerendered) is rebuilt when content is published: point
Settings › Deploy at a deploy hook. A site that **renders on demand** gets a
signed purge at `/_cms/webhook` instead, and a **hybrid** one (some pages
prerendered, some on demand) gets both: the purge for its on-demand pages
and the rebuild for its prerendered ones (the deploy's kind is
`purge+build`). A change of rendering waits for approval in Settings ›
Deploy. Set these as the Worker's secrets:

- `CMS_WEBHOOK_SECRET`, the purge secret from Settings › Deploy;
- `CLOUDFLARE_ZONE_ID` and `CLOUDFLARE_API_TOKEN` (with Cache Purge), to purge
  Cloudflare's cache by tag.

`/_cms/webhook` (`/_cms/webhook/` on a site with `trailingSlash: "always"`, and the build reports that address) checks the signature (contracts/webhook_contract.json): from a CMS at 2.8.0 or later `X-CMS-Signature-V2` with `X-CMS-Timestamp`, refusing a post more than five minutes old or ahead, so a captured one can't be replayed; from an older CMS `X-CMS-Signature`,
and takes the deploy's purge (`{tags, reason}`) or a webhook's event: `page.*`
and `entry.*` purge what they name, `global.updated` its global, and
`schema.changed` answers `202 rebuild_required` — the site's code was checked
against the old schema.

On an on-demand page `Astro.locals.cms` is a client for the request; every
answer it gets is added to the response's `Cache-Tag`. Live collections
(`@librepublish/astro/live`) add theirs when you hand the result to
`cacheHint(Astro, result.cacheHint)`:

```ts
// src/live.config.ts
import { defineLiveCollection } from "astro:content";
import { cmsLivePages, cmsLiveEntries } from "@librepublish/astro/live";
export const collections = {
  livePages: defineLiveCollection({ loader: cmsLivePages() }),
  livePosts: defineLiveCollection({ loader: cmsLiveEntries("posts") }),
};
```

Prerender in Node (`prerenderEnvironment: "node"`) on Cloudflare: workerd
doesn't read `.env` at build time. At request time the server reads
`CMS_BASE_URL` and `CMS_API_TOKEN` from its environment (on Cloudflare, the
Worker's variables and secrets; locally, `.dev.vars`).

## Site health

Every build checks the site against the CMS's Site health (`GET
/api/v1/site_health`: the site's URL, meta descriptions, a home page, alt
text) and its own basics (a sitemap, robots.txt, a 404 page), and warns about
what fails. `cms({ siteHealth: "error" })` makes a failing check stop the build.

## Options

| Option | Default | |
|---|---|---|
| `url`, `token` | `CMS_BASE_URL`, `CMS_API_TOKEN` | Where the CMS is, and the site's service token. |
| `i18n` | `true` | Sets up Astro's i18n from the CMS's locales. Every locale except the default gets a path prefix. |
| `sitemap` | `true` | Adds `/sitemap.xml`, and `/robots.txt` unless `public/robots.txt` exists. The sitemap's URLs follow the site's `trailingSlash` (`always` or `never`), so they match its canonicals. After a build, the sitemap keeps only the URLs the site serves (its built pages and on-demand routes), and warns about the rest. |
| `siteHealth` | `"warn"` | `"error"` stops the build on a failing check; `"off"` skips the checks. |
| `report` | `true` | Tells the CMS about each build (`POST /api/frontend/builds`): how the site renders, its webhook, and the content cursor it built from. |

## Entry points

| Import | |
|---|---|
| `@librepublish/astro` | `cms()`, the integration. |
| `@librepublish/astro/loaders` | `cmsPages`, `cmsEntries`, `cmsGlobals`, `cmsAssets`. |
| `@librepublish/astro/live` | `cmsLivePages`, `cmsLiveEntries`, `cacheHint`. |
| `@librepublish/astro/client` | `createClient`, `linkHref`, `recordPath`, `routeParam`, `CmsError`, and the API's types. |
| `@librepublish/astro/rich-text` | `renderRichText`, `isSafeHref`. |
| `@librepublish/astro/branding` | `brandingCss`, `brandingFontHref`, `checkedBranding`, `hexColor`, `isLight`. |
| `@librepublish/astro/forms` | `formDefinition` and the form types. |
| `@librepublish/astro/forms/rules` | The generic validator `<Form>` runs: `validate`, `check`, `shown`, `postedFrom`. |
| `@librepublish/astro/forms/browser` | What a form does in the browser, for `<Form>` and `<FormIsland>`: `fetchDefinition`, `jsonBody`, `submit`, `outcome`, `defaultValues`, `MESSAGES`. |
| `@librepublish/astro/forms/hook` | `formHook`, `FormHookRefusal`, `answer`: a form's hook endpoint. |
| `@librepublish/astro/schema` | `buildSchemas`: the CMS's JSON Schema as Zod. |
| `@librepublish/astro/components/*.astro` | `Blocks`, `Image`, `RichText`, `BrandStyles`, `Seo`, `Form`, `StaticForm`. |
| `@librepublish/astro/components/FormIsland.svelte` | The island `StaticForm` renders, for a site's own Svelte component. |
| `librepublish:types` | Generated from the CMS's schema. |
| `npx librepublish-astro sync\|check` | The schema lock. |

## Changes in 0.7.0

- **Forms on a static site**: `<StaticForm slug>` (and the Svelte island it
  renders, `<FormIsland>`) draws a CMS form in the browser from its live
  definition and posts straight to the CMS, so a fully static site has the
  CMS's forms and an edit shows without a build. Same markup, classes,
  `data-state`, validator and answers as `<Form>`; slots, class hooks,
  `renderers`, `beforeSubmit` and `cms-form:*` events for a site's own
  design and checks.
- `@librepublish/astro/forms/browser`: the browser half of a form, which
  `<Form>`'s script now shares with the island.
- `svelte` and `@astrojs/svelte` are optional peer dependencies (only for
  `<StaticForm>`). `npm run typecheck` also runs `svelte-check`.

## Changes in 0.6.0

- **Redirects live in the CMS, and only there.** `_redirects` is written
  from the CMS on every build, with nothing of the site's own: Astro's
  `redirects` or rules in `public/_redirects` stop the build, naming them.
  Move them to Tools › Redirects.
- The `redirects` option is gone (it turned the CMS's redirects off);
  passing it is an error.

## Changes in 0.3.4

- Fields shown only for some answers (`show_if`, librepublishgo's Forms
  1.2): `<Form>` draws them hidden and disabled until the answers that show
  them are given, and the validator skips them while hidden (`shown`).
- `formHook` (`@librepublish/astro/forms/hook`): the endpoint a form's hook
  posts to, its signature checked (`CMS_FORM_HOOK_SECRET`, a new optional
  env secret): redirect the visitor, add values, or refuse with errors.
- `<Form id>`, for a page with the same form twice.
- The contract's `submission.created` webhook is ignored by `/_cms/webhook`
  (nothing to purge).

## Changes in 0.3.3

- `richtext` fields: the CMS's rich text, the admin editor's document
  (Tiptap JSON). The schema types it (`RichText`), every document is
  validated, and `<RichText>` / `renderRichText()` draw it as HTML.

## Changes in 0.3.2

- `site.branding` (`CmsBranding`): the CMS's Settings › Brand — logo,
  favicon, colors, font, corners, shadow — from `GET /api/v1/site`.
- `<BrandStyles />` and `brandingCss` (`@librepublish/astro/branding`): the
  branding as `--brand-*` CSS custom properties, every value checked again
  and rebuilt before it reaches the CSS.

## Changes in 0.3.1

- `<RichText>` and `renderRichText` (`@librepublish/astro/rich-text`): the
  CMS's Markdown fields as safe HTML. New dependency: `markdown-it`.
- Generated types note each `markdown` field (and `body_markdown`) as CMS
  Markdown to render with `<RichText>`.
- The CMS now refuses HTML in `string`, `text` and `markdown` fields, and
  its schema marks `markdown` fields `contentMediaType: "text/markdown"`
  (a new schema digest: run `npx librepublish-astro sync`).

## Changes in 0.3

0.3 is for the Go core (this repository) and breaks with 0.2, which was
written for the Rails core's API.

**New**

- The schema lock (`cms.lock.json`, `npx librepublish-astro sync|check`,
  `LIBREPUBLISH_ACCEPT_SCHEMA=1`), enforced by `astro build`, `astro check`
  and `astro sync`.
- Loaders validate every record: `createSchema()` gives Astro the CMS's
  schema as strict Zod and the TypeScript of each collection's `Entry`, so
  collections are typed without casts.
- `BlockComponents` / `BlockProps<K>`: every block type needs a component, at
  type-check time and at build time.
- `<Form>` renders on demand from the live definition, with every field type
  of the Go Forms plugin, its rules checked in the browser, `_hp`/`_ts`
  always sent, and the captcha's script from the definition.
- `<Image>` and `image.breakpoints` follow `site.image_widths`; the CMS's file
  host (with its port) is in `image.remotePatterns`.
- Held to the CMS's recorded contract (`contracts/` at the repository root):
  the tests run on the Go core's golden fixtures, and this package's
  canonical JSON reproduces the CMS's schema and form digests.
- `/_cms/webhook` takes the Go deploy's purge and the webhook contract's
  events, including `schema.changed`.
- Live collections check what they load against the live schema.

**Changed**

- The Go core's shapes: `/api/v1/schema` is `{blocks, collections, globals,
  pages, seo}` with each entry a JSON Schema; the sitemap's URLs are
  `{loc, path, lastmod, locale, type, alternates: [{hreflang, href}]}`; Site
  health checks are `{key, state, message}`; forms come from the Forms
  plugin's `/api/x/forms/definition` and post to `/api/x/forms/submit`.
- Type generation errors stop a build (they were warnings).
- Generated types: 0.2's `Collections` is `Entries` (each a whole entry
  type), and `Page`, `Global`, `Asset`, `BlockOf<K>`, `BlockProps<K>`,
  `BlockComponents` are new; `HeroBlock`, `PostsFields` and `NavGlobal` keep
  their names.
- `<Blocks>` no longer skips a block type with no component: it stops the
  build (and `astro dev`); on demand it's logged and left out.
- Synced patterns come expanded into their blocks: `pattern` is no longer a
  block type, so drop its entry from your components map (keeping it is a
  type error).
- The lock needs the CMS's `meta.schema_digest` (a CMS without it is refused)
  and records its `cms_version`.
- robots.txt always comes from the CMS (`/api/v1/robots`), with the sitemap
  line added when it has none.

**Removed** (no Go counterpart)

- Commerce: `<QuoteRequest>`, `@librepublish/astro/commerce`
  (`quoteRequestAction`, `commerceEnabled`).
- Form emails in the site's design: the `formEmails` option,
  `emailTemplatePaths`, `digestMeta`, `answersRow` (the Go Forms plugin
  writes its own emails, edited in the CMS).
- `getForm` / `getForms` (`/api/v1/forms` doesn't exist in the Go core) and
  hand-built forms: a form is drawn only by `<Form>`.
- `AGENTS.md` (the `agentsMd` option): the Go core serves no frontend guide.
- The client's `admin()` (management API) helper.

**Migrating from 0.2**

1. Point `CMS_BASE_URL` at the Go core and issue a token
   (`librepublish token create --name PRODUCTION`).
2. Remove `formEmails`, `agentsMd` from `cms({…})`; delete the
   `src/pages/emails/` route and any `<QuoteRequest>`.
3. Remove any `schema` you gave the CMS collections in `content.config.ts`,
   and the casts on their data (`as unknown as CmsPage`): it's typed now.
4. Replace `components={{ … }}` maps with one `satisfies BlockComponents`
   covering every block type.
5. Pages with `<Form>`: `export const prerender = false`, and an adapter
   (or, on a static site, `<StaticForm>`).
6. `npx librepublish-astro sync`, `npx astro check`, commit `cms.lock.json`.

## Develop

```sh
npm install
npm run build
npm test         # builds, then the unit tests (node --test)
npx tsc --noEmit
npm run e2e      # the example site against a real Go core, end to end
```

The unit tests run on the API contract, copied from
[librepublishgo](https://github.com/Martin-Business-Consultants/librepublishgo)
into `librepublishgo/contracts/` (`delivery/`, `forms/`, `webhooks/`,
`index.json`): the golden responses the Go core records and is held to by
its `TestContract`. They're the integration's half of the drift gate
(`librepublishgo/contracts/README.md`): the digests the
CMS recorded are recomputed here, the form validator must reach the server's
recorded verdict, `<Form>` renders the recorded definition (through Astro's
container), `<FormIsland>` draws it in jsdom and is answered with the
recorded posts, and `test/contracts.sha256` pins the contract files this package
was last checked against — so a contract change fails here until the
integration is updated for it and re-pinned:

```sh
npm run contracts:sync -- ../librepublishgo   # copies contracts/ and the forms palette, records the commit
npm test                 # fails: "librepublishgo/contracts/ changed since this package was checked against it"
# update src/ and test/ for the change, then
npm run contracts:pin    # rewrites test/contracts.sha256; commit it with the change
```

`npm run e2e` builds the Go binary from a librepublishgo checkout
(`LIBREPUBLISH_REPO`, `../librepublishgo` by default), or uses
`LIBREPUBLISH_BIN`, starts it on a fresh data directory, seeds it through the
management API, and then: checks a build without a lock fails; syncs the
lock and runs `astro check`; builds `example/` hybrid and with live routes
(`SSR=1`) and checks what came out; serves it and checks `/contact` draws the
live form (and follows an edit without a build) and that `/_cms/webhook`
takes only a signed body; and checks each failure the integration promises —
a form on a prerendered page, a moved schema (build, sync and check),
`LIBREPUBLISH_ACCEPT_SCHEMA=1` and the type error that follows, content using
a block type with no component, and content outside the schema. CI runs both
(`.github/workflows/ci.yml`; the end to end builds the Go core at the
librepublishgo commit in `librepublishgo/SOURCE`), and librepublishgo's CI
runs the unit tests on its own `contracts/`, so a contract change there
fails until this package follows. Locally:

```sh
# Go and Node 22.12+
npm ci && npm run build && npm run typecheck && npm test
(cd example && npm ci)
LIBREPUBLISH_REPO=../librepublishgo npm run e2e    # or: LIBREPUBLISH_BIN=/path/to/librepublish npm run e2e
```

Functional Source License 1.1, with an MIT future license, like the CMS ([LICENSE.md](LICENSE.md)).
