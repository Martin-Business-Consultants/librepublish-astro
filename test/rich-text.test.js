// CMS Markdown as HTML: what the admin's editor (Tiptap's Markdown) writes,
// rendered; and whatever else a value holds, never let through as markup.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { getViteConfig } from "astro/config";
import { experimental_AstroContainer } from "astro/container";
import { isSafeHref, renderRichText } from "../dist/rich-text.js";
import { fixture } from "./helpers.js";

test("every construct the editor writes", () => {
  const cases = [
    ["paragraphs", "One.\n\nTwo.", "<p>One.</p>\n<p>Two.</p>\n"],
    ["headings", "# One\n\n## Two\n\n### Three\n\n#### Four", "<h1>One</h1>\n<h2>Two</h2>\n<h3>Three</h3>\n<h4>Four</h4>\n"],
    ["marks", "**bold** *italic* ~~struck~~ `code` *~~both~~*",
      "<p><strong>bold</strong> <em>italic</em> <s>struck</s> <code>code</code> <em><s>both</s></em></p>\n"],
    ["a link", "[About](/about)", '<p><a href="/about">About</a></p>\n'],
    ["a hard break (two spaces)", "one  \ntwo", "<p>one<br>\ntwo</p>\n"],
    ["a hard break (backslash)", "one\\\ntwo", "<p>one<br>\ntwo</p>\n"],
    ["nested lists", "- a\n  - b\n\n1. one\n2. two",
      "<ul>\n<li>a\n<ul>\n<li>b</li>\n</ul>\n</li>\n</ul>\n<ol>\n<li>one</li>\n<li>two</li>\n</ol>\n"],
    ["a task list", "- [x] done\n- [ ] to do",
      '<ul>\n<li class="task-list-item"><input type="checkbox" disabled checked> done</li>\n<li class="task-list-item"><input type="checkbox" disabled> to do</li>\n</ul>\n'],
    ["a quote", "> said  \n> *this*", "<blockquote>\n<p>said<br>\n<em>this</em></p>\n</blockquote>\n"],
    ["a code block", "```html\n<p>hi</p>\n```", '<pre><code class="language-html">&lt;p&gt;hi&lt;/p&gt;\n</code></pre>\n'],
    ["a rule", "a\n\n---\n\nb", "<p>a</p>\n<hr>\n<p>b</p>\n"],
    ["escaped text", "1 &lt; 2 &amp; \\*not em\\* &lt;b&gt;", "<p>1 &lt; 2 &amp; *not em* &lt;b&gt;</p>\n"],
    ["an empty paragraph", "a\n\n&nbsp;\n\nb", "<p>a</p>\n<p> </p>\n<p>b</p>\n"],
  ];
  for (const [name, markdown, html] of cases) assert.equal(renderRichText(markdown), html, name);
});

test("HTML in the Markdown is escaped, never passed through", () => {
  const cases = [
    ["<script>alert(1)</script>", "<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>\n"],
    ['<img src=x onerror="alert(1)">', "<p>&lt;img src=x onerror=&quot;alert(1)&quot;&gt;</p>\n"],
    ["a <b>bold</b> word", "<p>a &lt;b&gt;bold&lt;/b&gt; word</p>\n"],
    ["<div>\n\n**x**\n\n</div>", "<p>&lt;div&gt;</p>\n<p><strong>x</strong></p>\n<p>&lt;/div&gt;</p>\n"],
    ["<!-- hidden -->", "<p>&lt;!-- hidden --&gt;</p>\n"],
    ["&#60;b&#62; &lt;i&gt;", "<p>&lt;b&gt; &lt;i&gt;</p>\n"],
    ["[x](/a \"t\" onmouseover=alert(1))", "<p>[x](/a &quot;t&quot; onmouseover=alert(1))</p>\n"],
    ['[x](/a "\\" onclick=\\"y")', '<p><a href="/a" title="&quot; onclick=&quot;y">x</a></p>\n'],
  ];
  for (const [markdown, html] of cases) assert.equal(renderRichText(markdown), html, markdown);
});

test("links go only to http(s), mailto:, tel: or a path", () => {
  for (const href of ["javascript:alert(1)", "JaVaScRiPt:alert(1)", "&#106;avascript:alert(1)", "vbscript:x", "data:text/html,x", "file:///etc/passwd", "<javascript:x>"]) {
    const html = renderRichText(`[x](${href})`);
    assert.doesNotMatch(html, /<a /, href);
  }
  assert.doesNotMatch(renderRichText("<javascript:alert(1)>"), /<a /);
  assert.equal(renderRichText("[a](https://x.test) [b](/p) [c](#top) [d](mailto:a@x.test) [e](tel:+15550100) <https://y.test> <a@x.test>"),
    '<p><a href="https://x.test">a</a> <a href="/p">b</a> <a href="#top">c</a> <a href="mailto:a@x.test">d</a> <a href="tel:+15550100">e</a> '
    + '<a href="https://y.test">https://y.test</a> <a href="mailto:a@x.test">a@x.test</a></p>\n');
  assert.equal(isSafeHref(" java\tscript:x"), false);
  assert.equal(isSafeHref("/a:b"), true);
});

test("images and tables, which the editor doesn't write, stay text", () => {
  assert.equal(renderRichText("![pixel](https://t.test/p.gif)"), '<p>!<a href="https://t.test/p.gif">pixel</a></p>\n');
  assert.doesNotMatch(renderRichText("| a |\n|---|\n| 1 |"), /<table/);
});

test("rel and target go on links to other sites only", () => {
  assert.equal(renderRichText("[a](https://x.test) [b](/p) [c](mailto:a@x.test)", { rel: "noopener noreferrer", target: "_blank" }),
    '<p><a href="https://x.test" rel="noopener noreferrer" target="_blank">a</a> <a href="/p">b</a> <a href="mailto:a@x.test">c</a></p>\n');
});

test("inline: no <p>", () => {
  assert.equal(renderRichText("Built in **1869**", { inline: true }), "Built in <strong>1869</strong>");
  assert.equal(renderRichText("<b>x</b>", { inline: true }), "&lt;b&gt;x&lt;/b&gt;");
});

test("no value is no HTML", () => {
  for (const value of [undefined, null, "", "  \n", 42]) assert.equal(renderRichText(value), "");
});

test("the contract's markdown fields render", () => {
  const { data } = fixture("delivery", "entries-posts");
  const first = data.find((entry) => entry.slug === "first-post");
  assert.equal(renderRichText(first.frontmatter.author.bio), "<p>Writes <em>things</em>.</p>\n");
  assert.equal(renderRichText(first.body_markdown), "<h1>First post</h1>\n<p>Words.</p>\n");
});

// <RichText>, rendered for real through Astro's container.
let server;
let render;

before(async () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const config = await getViteConfig(
    { root, logLevel: "silent", appType: "custom", server: { middlewareMode: true, hmr: false, ws: false } },
    { root, logLevel: "silent" },
  )({ mode: "test", command: "serve" });
  server = await createServer({ ...config, configFile: false });
  const { default: RichText } = await server.ssrLoadModule("/src/components/RichText.astro");
  const container = await experimental_AstroContainer.create();
  render = (props) => container.renderToString(RichText, { props, partial: true });
});

after(() => server?.close());

test("<RichText> places the HTML, wrapped only when given a class", async () => {
  assert.equal((await render({ value: "Hi <b>there</b> *you*" })).trim(), "<p>Hi &lt;b&gt;there&lt;/b&gt; <em>you</em></p>");
  assert.equal((await render({ value: "Hi", class: "prose" })).trim(), '<div class="prose"><p>Hi</p>\n</div>');
  assert.equal((await render({ value: "**Hi**", inline: true })).trim(), "<strong>Hi</strong>");
  assert.equal((await render({ value: "**Hi**", inline: true, class: "lead" })).trim(), '<span class="lead"><strong>Hi</strong></span>');
  assert.equal((await render({ value: "[x](https://x.test)", rel: "noopener" })).trim(), '<p><a href="https://x.test" rel="noopener">x</a></p>');
  assert.equal((await render({ value: undefined, class: "prose" })).trim(), "");
});

// ---- richtext documents (the admin editor's Tiptap JSON) -------------------

const p = (...content) => ({ type: "paragraph", content });
const t = (text, ...marks) => ({ type: "text", text, ...(marks.length ? { marks } : {}) });
const doc = (...content) => ({ type: "doc", content });

test("a document renders the editor's nodes and marks", () => {
  const html = renderRichText(doc(
    p(t("Built in "), t("1869", { type: "bold" }), t(", a "), t("mill", { type: "italic" }, { type: "bold" }), t("."), { type: "hardBreak" }, t("Now a brewpub.")),
    { type: "heading", attrs: { level: 3 }, content: [t("Today")] },
    { type: "bulletList", content: [{ type: "listItem", content: [p(t("beer"))] }] },
    { type: "orderedList", attrs: { start: 3 }, content: [{ type: "listItem", content: [p(t("three"))] }] },
    { type: "blockquote", content: [p(t("quoted"))] },
    { type: "horizontalRule" },
    { type: "codeBlock", attrs: { language: "js" }, content: [t("a < b")] },
    { type: "taskList", content: [{ type: "taskItem", attrs: { checked: true }, content: [p(t("done"))] }] },
  ));
  assert.equal(html,
    "<p>Built in <strong>1869</strong>, a <strong><em>mill</em></strong>.<br>Now a brewpub.</p>" +
    "<h3>Today</h3><ul><li><p>beer</p></li></ul><ol start=\"3\"><li><p>three</p></li></ol>" +
    "<blockquote><p>quoted</p></blockquote><hr><pre><code class=\"language-js\">a &lt; b</code></pre>" +
    "<ul class=\"contains-task-list\"><li class=\"task-list-item\"><input type=\"checkbox\" disabled checked> <p>done</p></li></ul>");
});

test("a document's text is escaped and only safe links are links", () => {
  const html = renderRichText(doc(p(
    t("<script>alert(1)</script>"),
    t("bad", { type: "link", attrs: { href: "javascript:alert(1)" } }),
    t("ok", { type: "link", attrs: { href: "https://example.com/?a=1&b=\"2\"" } }),
    t("menu", { type: "link", attrs: { href: "/menu/" } }),
    t("x", { type: "textStyle", attrs: { color: "red" } }),
  )), { rel: "noopener", target: "_blank" });
  assert.equal(html, "<p>&lt;script&gt;alert(1)&lt;/script&gt;bad" +
    "<a href=\"https://example.com/?a=1&amp;b=&quot;2&quot;\" rel=\"noopener\" target=\"_blank\">ok</a>" +
    "<a href=\"/menu/\">menu</a>x</p>");
});

test("a document renders inline, and empty documents render nothing", () => {
  assert.equal(renderRichText(doc(p(t("One "), t("line", { type: "bold" }))), { inline: true }), "One <strong>line</strong>");
  assert.equal(renderRichText({ type: "doc" }), "");
  assert.equal(renderRichText(doc({ type: "paragraph" })), "");
  assert.equal(renderRichText(null), "");
});
