// Copies what the tests are held to from a librepublishgo checkout: the API
// contract (contracts/) and the Forms plugin's field palette
// (plugins/forms/manifest.go), into librepublishgo/, and records the
// checkout's commit in librepublishgo/SOURCE (the end to end builds the Go
// core at that commit). Then `npm test`; when contracts/ moved, test/contract.test.js
// fails until the integration follows and `npm run contracts:pin` re-pins it.
//
//   npm run contracts:sync -- ../librepublishgo
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const from = resolve(process.argv[2] ?? "../librepublishgo");
const to = fileURLToPath(new URL("../librepublishgo/", import.meta.url));
if (!existsSync(join(from, "contracts/index.json"))) {
  console.error(`${from} isn't a librepublishgo checkout (no contracts/index.json).`);
  process.exit(1);
}
const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: from, encoding: "utf8" });
if (head.status !== 0) {
  console.error(`${from}: git rev-parse HEAD failed: ${head.stderr}`);
  process.exit(1);
}
rmSync(join(to, "contracts"), { recursive: true, force: true });
cpSync(join(from, "contracts"), join(to, "contracts"), { recursive: true });
mkdirSync(join(to, "plugins/forms"), { recursive: true });
cpSync(join(from, "plugins/forms/manifest.go"), join(to, "plugins/forms/manifest.go"));
writeFileSync(join(to, "SOURCE"), `${head.stdout.trim()}\n`);
console.log(`Copied contracts/ and the forms palette from ${from} at ${head.stdout.trim().slice(0, 12)}.`);
