// The site's branding as CSS custom properties: the recorded /site's, and
// whatever else a value holds never reaching the CSS as it came.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { getViteConfig } from "astro/config";
import { experimental_AstroContainer } from "astro/container";
import { brandingCss, brandingFontHref, checkedBranding, hexColor, isLight } from "../dist/branding.js";
import { fixture } from "./helpers.js";

const site = fixture("delivery", "site").data;

test("the contract's branding", () => {
  const b = site.branding;
  assert.equal(b.logo.url, "https://cms.acme.example/files/<blob>/hero.png");
  assert.equal(b.favicon.width, 40);
  assert.equal(b.top_bar, undefined, "the admin's top bar isn't delivered");
  assert.equal(brandingCss(site),
    ':root{--brand-primary:#b45309;--brand-on-primary:#ffffff;--brand-secondary:#1c1917;'
    + '--brand-font:"Playfair Display", Georgia, "Times New Roman", serif;--brand-radius:0.5rem;--brand-shadow:0 1px 2px 0 rgb(0 0 0 / 0.05)}');
  assert.equal(brandingCss(b), brandingCss(site), "the branding itself does too");
  assert.equal(brandingFontHref(site), "https://fonts.googleapis.com/css2?family=Playfair+Display:wght@400;500;600;700&display=swap");
});

test("only checked values reach the CSS", () => {
  const hostile = {
    primary_color: "#fff;}body{display:none", secondary_color: "red", font: "x\"; } * { color: red", border_radius: "huge",
    box_shadow: "0 0 0 red", logo: { url: 1 }, favicon: "x", toString: "x",
  };
  assert.deepEqual(checkedBranding(hostile), {});
  assert.equal(brandingCss(hostile), "");
  assert.equal(brandingCss({ branding: hostile }), "");
  assert.equal(brandingFontHref(hostile), null);
  assert.equal(brandingCss({ primary_color: " #ABC ", font: "constructor", border_radius: "none", box_shadow: "none" }),
    ":root{--brand-primary:#aabbcc;--brand-on-primary:#1c1917;--brand-radius:0;--brand-shadow:none}");
  assert.equal(brandingCss({ font: "Inter" }, { selector: "html.site</style><script>{" }), 'html.site/stylescript{--brand-font:"Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans", Helvetica, Arial, sans-serif}');
  for (const empty of [undefined, null, {}, { branding: {} }]) assert.equal(brandingCss(empty), "");
});

test("hex colors and what reads on them", () => {
  assert.equal(hexColor("#0AF"), "#00aaff");
  for (const bad of ["#12345", "0af", "#ggg", "#0af0af0", "rgb(0,0,0)", 42, null]) assert.equal(hexColor(bad), null, String(bad));
  assert.equal(isLight("#ffffff"), true);
  assert.equal(isLight("#fde047"), true);
  assert.equal(isLight("#b45309"), false);
  assert.equal(isLight("#000"), false);
});

// <BrandStyles>, rendered for real through Astro's container.
let server;
let render;

before(async () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const config = await getViteConfig(
    { root, logLevel: "silent", appType: "custom", server: { middlewareMode: true, hmr: false, ws: false } },
    { root, logLevel: "silent" },
  )({ mode: "test", command: "serve" });
  server = await createServer({ ...config, configFile: false });
  const { default: BrandStyles } = await server.ssrLoadModule("/src/components/BrandStyles.astro");
  const container = await experimental_AstroContainer.create();
  render = (props) => container.renderToString(BrandStyles, { props, partial: true });
});

after(() => server?.close());

test("<BrandStyles> draws the rule, and the font's stylesheet when asked", async () => {
  const html = await render({ site });
  assert.equal(html.trim(), `<style>${brandingCss(site)}</style>`);
  const withFont = await render({ site, loadFont: true });
  assert.match(withFont, /<link rel="stylesheet" href="https:\/\/fonts\.googleapis\.com\/css2\?family=Playfair\+Display:wght@400;500;600;700&(amp;)?display=swap">/);
  assert.equal((await render({ branding: { primary_color: "</style><script>alert(1)</script>" } })).trim(), "");
  assert.equal((await render({ site: null })).trim(), "");
});
