# Example site

The smallest Astro site on LibrePublish CMS (the Go core): every page and
post, the nav, SEO tags, a sitemap, the CMS's redirects, and the contact
form rendered on demand. It's written against the starter block types
(`librepublish seed-blocks`), a `posts` collection, a `nav` global and a
`contact` form — what `npm run e2e` in the package seeds into a fresh CMS.

```sh
cp .env.example .env              # CMS_BASE_URL and a service token
npm install
npx librepublish-astro sync       # pin the CMS's schema in cms.lock.json
npm run check                     # the types follow it: every block type has a component
npm run dev
npm run build                     # Node adapter; ADAPTER=cloudflare for Workers
SSR=1 npm run build               # live collections too (src/pages/live/)
```

cms.lock.json isn't committed here, since the example has no CMS of its own;
a real site commits it.
