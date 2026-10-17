/**
 * The site's visual identity (the CMS's Settings › Brand), as CSS custom
 * properties: GET /api/v1/site's `data.branding`.
 *
 *   import { brandingCss } from "@librepublish/astro/branding";
 *   const css = brandingCss(site);
 *   // :root{--brand-primary:#b45309;--brand-on-primary:#fff;--brand-font:"Lora", Georgia, …;--brand-radius:0.5rem;…}
 *
 * or <BrandStyles site={site} /> (components/BrandStyles.astro) in the
 * <head>, which does this. The site's own CSS reads the properties:
 * `color: var(--brand-primary, #111)`.
 *
 * The CMS checks every value when it's saved and again when it delivers it;
 * this checks them a third time, on this side of the wire, because they go
 * into CSS: a color is a hex color, a font, corner or shadow one of the
 * CMS's names, and what isn't is left out. No string from the API is ever
 * placed into the CSS as it is: the values written are rebuilt from the
 * checked hex digits and this module's own tables.
 */
import type { CmsAsset, CmsBranding, CmsSite } from "./types.js";

export type BrandFont = "Inter" | "DM Sans" | "Manrope" | "Playfair Display" | "Lora";
export type BrandSize = "none" | "small" | "medium" | "large";

const SANS = '-apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans", Helvetica, Arial, sans-serif';
const SERIF = 'Georgia, "Times New Roman", serif';

/** Each font the CMS offers, with a fallback of its kind. */
export const BRAND_FONTS: Record<BrandFont, string> = {
  Inter: `"Inter", ${SANS}`,
  "DM Sans": `"DM Sans", ${SANS}`,
  Manrope: `"Manrope", ${SANS}`,
  "Playfair Display": `"Playfair Display", ${SERIF}`,
  Lora: `"Lora", ${SERIF}`,
};

/** Corners: a card's or a button's radius (the CMS admin's own). */
export const BRAND_RADII: Record<BrandSize, string> = { none: "0", small: "0.25rem", medium: "0.5rem", large: "0.875rem" };

/** Shadow: under a card or a panel (the CMS admin's own). */
export const BRAND_SHADOWS: Record<BrandSize, string> = {
  none: "none",
  small: "0 1px 2px 0 rgb(0 0 0 / 0.05)",
  medium: "0 1px 3px 0 rgb(0 0 0 / 0.1), 0 1px 2px -1px rgb(0 0 0 / 0.1)",
  large: "0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1)",
};

const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;

/** A hex color (#rgb or #rrggbb) as #rrggbb in lowercase, or null. */
export function hexColor(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const m = HEX.exec(value.trim());
  if (!m) return null;
  const digits = m[1].length === 3 ? [...m[1]].map((d) => d + d).join("") : m[1];
  return `#${digits.toLowerCase()}`;
}

/** Whether dark text reads better than white on a color (WCAG relative luminance above 0.45, as the admin decides). */
export function isLight(hex: string): boolean {
  const c = hexColor(hex);
  if (!c) return false;
  const [r, g, b] = [1, 3, 5].map((i) => {
    const v = parseInt(c.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.45;
}

const own = <T extends string>(table: Record<T, string>, value: unknown): T | null =>
  typeof value === "string" && Object.hasOwn(table, value) ? (value as T) : null;

const isAsset = (value: unknown): value is CmsAsset =>
  !!value && typeof value === "object" && typeof (value as CmsAsset).url === "string";

/** The branding of a site (or the branding itself), with only the values that pass the checks. */
export function checkedBranding(source: Pick<CmsSite, "branding"> | CmsBranding | null | undefined): CmsBranding {
  const raw = ((source && "branding" in source ? source.branding : source) ?? {}) as Record<string, unknown>;
  const out: CmsBranding = {};
  if (isAsset(raw.logo)) out.logo = raw.logo;
  if (isAsset(raw.favicon)) out.favicon = raw.favicon;
  const primary = hexColor(raw.primary_color), secondary = hexColor(raw.secondary_color);
  if (primary) out.primary_color = primary;
  if (secondary) out.secondary_color = secondary;
  const font = own(BRAND_FONTS, raw.font), radius = own(BRAND_RADII, raw.border_radius), shadow = own(BRAND_SHADOWS, raw.box_shadow);
  if (font) out.font = font;
  if (radius) out.border_radius = radius;
  if (shadow) out.box_shadow = shadow;
  return out;
}

export interface BrandingCssOptions {
  /** The rule's selector. Default ":root". */
  selector?: string;
}

/**
 * The branding as one CSS rule of custom properties, only those set:
 * `--brand-primary`, `--brand-on-primary` (white, or near-black on a light
 * primary), `--brand-secondary`, `--brand-font` (the family, then a
 * fallback), `--brand-radius` and `--brand-shadow`. "" when nothing is set.
 */
export function brandingCss(source: Pick<CmsSite, "branding"> | CmsBranding | null | undefined, options: BrandingCssOptions = {}): string {
  const b = checkedBranding(source);
  const props: string[] = [];
  if (b.primary_color) {
    props.push(`--brand-primary:${b.primary_color}`, `--brand-on-primary:${isLight(b.primary_color) ? "#1c1917" : "#ffffff"}`);
  }
  if (b.secondary_color) props.push(`--brand-secondary:${b.secondary_color}`);
  if (b.font) props.push(`--brand-font:${BRAND_FONTS[b.font]}`);
  if (b.border_radius) props.push(`--brand-radius:${BRAND_RADII[b.border_radius]}`);
  if (b.box_shadow) props.push(`--brand-shadow:${BRAND_SHADOWS[b.box_shadow]}`);
  if (!props.length) return "";
  const selector = (options.selector ?? ":root").replace(/[{}<>;]/g, "");
  return `${selector}{${props.join(";")}}`;
}

/** The Google Fonts stylesheet for the branding's font (400–700), or null without one. */
export function brandingFontHref(source: Pick<CmsSite, "branding"> | CmsBranding | null | undefined): string | null {
  const font = checkedBranding(source).font;
  return font ? `https://fonts.googleapis.com/css2?family=${encodeURIComponent(font).replace(/%20/g, "+")}:wght@400;500;600;700&display=swap` : null;
}
