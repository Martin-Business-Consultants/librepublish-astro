// A component for every block type the CMS has. `satisfies BlockComponents`
// makes it a type error (astro check) to leave one out — say, after a new
// block type arrives with `npx librepublish-astro sync` — or to keep one the
// CMS dropped. These are the starter block types (librepublish seed-blocks).
import type { BlockComponents } from "librepublish:types";
import Fallback from "./Fallback.astro";
import Hero from "./Hero.astro";
import Text from "./Text.astro";
import Columns from "./Columns.astro";

export const components = {
  hero: Hero,
  text: Text,
  columns: Columns,
  card_grid: Fallback,
  collection_list: Fallback,
  contact_info: Fallback,
  cta: Fallback,
  cta_band: Fallback,
  divider: Fallback,
  embed: Fallback,
  feature_grid: Fallback,
  feature_list: Fallback,
  gallery: Fallback,
  heading: Fallback,
  image: Fallback,
  media_text: Fallback,
  partners_grid: Fallback,
  pitch: Fallback,
  quote: Fallback,
  stats_section: Fallback,
  testimonial_grid: Fallback,
} satisfies BlockComponents;
