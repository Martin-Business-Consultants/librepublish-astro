import { getCollection } from "astro:content";
import type { Assets } from "librepublish:types";

/** Every asset the content points at, by id. */
export async function assetsById(): Promise<Assets> {
  return Object.fromEntries((await getCollection("assets")).map((asset) => [asset.id, asset.data]));
}
