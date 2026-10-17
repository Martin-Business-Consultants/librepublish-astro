// Shared by the tests: the contract fixtures, a fake fetch, a fake loader context.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** The repository's contracts/ directory: the golden fixtures the Go core records (TestContract) and is held to. */
export const contracts = new URL("../../../contracts/", import.meta.url);

/** A contract fixture: contracts/<group>/<name>.json at the repository root. */
export function fixture(group, name) {
  return JSON.parse(readFileSync(fixturePath(group, name), "utf8"));
}

export function fixturePath(group, name) {
  return fileURLToPath(new URL(`${group}/${name}.json`, contracts));
}

/** contracts/index.json: for each fixture, the request that produced it, its status and its contract headers. */
export function contractIndex() {
  return JSON.parse(readFileSync(new URL("index.json", contracts), "utf8"));
}
export const envelope = (data, meta = {}, included) => ({ data, meta, ...(included ? { included } : {}) });

/** A fetch answering from a table of path (with or without query) → { body, status, headers } (or a function of the path). */
export function fakeFetch(routes) {
  const calls = [];
  const fetcher = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const parsed = new URL(url);
    const route = routes[parsed.pathname + parsed.search] ?? routes[parsed.pathname];
    if (!route) return new Response(JSON.stringify({ error: "not_found", message: "no route" }), { status: 404 });
    const { body, status = 200, headers = {} } = typeof route === "function" ? route(parsed, init) : route;
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers });
  };
  return { fetcher, calls };
}

/** Enough of Astro's LoaderContext for the loaders, with parseData running `schema`. */
export function fakeContext(schema, meta = {}) {
  const entries = new Map();
  return {
    entries,
    meta,
    context: {
      collection: "test",
      store: { set: (entry) => entries.set(entry.id, entry), delete: (id) => entries.delete(id), clear: () => entries.clear() },
      meta: { get: (key) => meta[key], set: (key, value) => { meta[key] = value; } },
      parseData: async ({ id, data }) => {
        const parsed = schema.safeParse(data);
        if (!parsed.success) throw new Error(`${id}: ${parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`);
        return parsed.data;
      },
      generateDigest: (data) => JSON.stringify(data).length.toString(),
      logger: { info() {}, warn() {}, debug() {} },
    },
  };
}
