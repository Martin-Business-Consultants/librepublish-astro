// The contract files (librepublishgo/contracts/**, but its README) this package was last
// checked against, by SHA-256: test/contracts.sha256. test/contract.test.js
// fails when contracts/ differs from it, so a change to the API's fixtures
// can't pass CI without a change here too.
//
//   npm run contracts:pin    # after updating the integration for a contract change
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

export const contractsDir = fileURLToPath(new URL("../librepublishgo/contracts/", import.meta.url));
export const pinFile = fileURLToPath(new URL("./contracts.sha256", import.meta.url));

/** Each contract file's sha256, as `<hex>  <path>` lines sorted by path (sha256sum's format). */
export function contractSums() {
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name !== "README.md") files.push(relative(contractsDir, path).split("\\").join("/"));
    }
  };
  walk(contractsDir);
  return files.sort().map((file) => `${createHash("sha256").update(readFileSync(join(contractsDir, file))).digest("hex")}  ${file}`).join("\n") + "\n";
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  writeFileSync(pinFile, contractSums());
  console.log(`Pinned ${contractSums().trim().split("\n").length} contract files in test/contracts.sha256.`);
}
