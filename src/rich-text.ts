/**
 * The CMS's rich text, as HTML. A `markdown` field (and an entry's
 * `body_markdown`) holds Markdown written in the admin's editor; every other
 * text field is plain text, and the CMS refuses HTML in either on save.
 *
 *   import { renderRichText } from "@librepublish/astro/rich-text";
 *   const html = renderRichText(post.frontmatter.bio);           // "<p>Writes <em>things</em>.</p>\n"
 *   const line = renderRichText(hero.tagline, { inline: true }); // no <p>
 *
 * or <RichText value={…} /> (components/RichText.astro), which does this.
 *
 * It renders what the editor writes: paragraphs, headings, bold, italic,
 * strikethrough, links, bullet, numbered and task lists (nested too),
 * quotes, code and code blocks, rules and line breaks. It's safe on any
 * input: HTML in the Markdown is escaped, never passed through, and a link
 * goes only to http(s), mailto:, tel: or a path — anything else (javascript:,
 * data:, …) stays text. Images and tables, which the editor doesn't write,
 * stay text too.
 *
 * markdown-it does the parsing: CommonMark with GFM's strikethrough, with
 * raw HTML off by default and a link check to hook, small, and maintained.
 */
import MarkdownIt from "markdown-it";
import type { StateCore, Token } from "markdown-it";

export interface RichTextOptions {
  /** One paragraph's worth, without the <p> around it: for a heading or a line of text. */
  inline?: boolean;
  /** The rel of links to other sites (absolute http(s) addresses), e.g. "noopener noreferrer". */
  rel?: string;
  /** The target of links to other sites, e.g. "_blank". */
  target?: string;
}

const SAFE_SCHEMES = new Set(["http", "https", "mailto", "tel"]);

/** Whether a link may go to url: http(s), mailto:, tel:, or a path — the CMS's own rule (fields.SafeURL). */
export function isSafeHref(url: string): boolean {
  // What a browser drops before it reads the scheme.
  const clean = url.replace(/[\u0000- \u007f]/g, "");
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(clean);
  return !scheme || SAFE_SCHEMES.has(scheme[1].toLowerCase());
}

const md = new MarkdownIt("default", { html: false, linkify: false, typographer: false, breaks: false });
md.disable(["image", "table"]);
md.validateLink = isSafeHref;

const external = (href: unknown) => typeof href === "string" && /^https?:\/\//i.test(href);

// Links to other sites get the rel and target asked for.
md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  const token = tokens[idx];
  const { rel, target } = (env ?? {}) as RichTextOptions;
  if (external(token.attrGet("href"))) {
    if (rel) token.attrSet("rel", rel);
    if (target) token.attrSet("target", target);
  }
  return self.renderToken(tokens, idx, options);
};

// Task lists, as the editor writes them: "- [ ] to do", "- [x] done".
const TASK = /^\[([ xX])\][  ]/;
md.core.ruler.after("inline", "task_lists", (state: StateCore) => {
  const tokens = state.tokens;
  for (let i = 2; i < tokens.length; i++) {
    const inline = tokens[i];
    if (inline.type !== "inline" || tokens[i - 1].type !== "paragraph_open" || tokens[i - 2].type !== "list_item_open") continue;
    const first = inline.children?.[0];
    const match = first?.type === "text" ? TASK.exec(first.content) : null;
    if (!first || !match) continue;
    first.content = first.content.slice(match[0].length);
    const box = new state.Token("task_checkbox", "input", 0);
    box.meta = { checked: match[1] !== " " };
    inline.children!.unshift(box);
    tokens[i - 2].attrJoin("class", "task-list-item");
  }
});
md.renderer.rules.task_checkbox = (tokens: Token[], idx: number) =>
  `<input type="checkbox" disabled${tokens[idx].meta?.checked ? " checked" : ""}> `;

/**
 * CMS Markdown as HTML, safe to set as a page's HTML; "" for no value.
 */
export function renderRichText(markdown: string | null | undefined, options: RichTextOptions = {}): string {
  if (typeof markdown !== "string" || !markdown.trim()) return "";
  const env = { rel: options.rel, target: options.target };
  return options.inline ? md.renderInline(markdown, env) : md.render(markdown, env);
}
