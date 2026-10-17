// A minimal site on LibrePublish CMS (the Go core). CMS_BASE_URL and
// CMS_API_TOKEN come from .env (or the environment); cms.lock.json pins the
// CMS schema it's written against (`npx librepublish-astro sync`).
//
// Pages are prerendered, except /contact: a <Form> renders on demand from the
// form's live definition, so the site has an adapter — Node by default (what
// the end-to-end test serves), Cloudflare with ADAPTER=cloudflare.
//
// SSR=1 also renders src/pages/live/ on demand (live collections); the
// integration then reports the site as rendering on demand ("server" or
// "hybrid"), and adds the purge webhook (/_cms/webhook) and the Cache-Tag
// middleware either way, since there's an adapter.
import { defineConfig } from "astro/config";
import cms from "@librepublish/astro";

const onDemand = process.env.SSR === "1";
const adapter = process.env.ADAPTER === "cloudflare"
  // Prerender in Node, where the build reads the CMS (workerd doesn't read .env).
  ? (await import("@astrojs/cloudflare")).default({ prerenderEnvironment: "node" })
  : (await import("@astrojs/node")).default({ mode: "standalone" });

export default defineConfig({
  adapter,
  integrations: [
    cms(),
    // src/pages/live/ renders on demand with SSR=1, and isn't built otherwise.
    {
      name: "example-live-routes",
      hooks: {
        "astro:route:setup": ({ route }) => {
          if (route.component.includes("src/pages/live/")) route.prerender = !onDemand;
        },
      },
    },
  ],
});
