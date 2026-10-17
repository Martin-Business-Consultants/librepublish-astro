import { defineLiveCollection } from "astro:content";
import { cmsLiveEntries, cmsLivePages } from "@librepublish/astro/live";

// For pages rendered on demand (SSR=1): read at request time, so a publish
// shows at once, each answer tagged for the CMS's purges.
export const collections = {
  livePages: defineLiveCollection({ loader: cmsLivePages() }),
  livePosts: defineLiveCollection({ loader: cmsLiveEntries("posts") }),
};
