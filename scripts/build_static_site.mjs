import { cp, mkdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = resolve(repoRoot, "dist");

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
for (const source of ["index.html", "styles.css", "script.js", "public-config.js", "README.md"]) {
  await cp(resolve(repoRoot, source), resolve(output, source));
}
await cp(resolve(repoRoot, "docs"), resolve(output, "docs"), { recursive: true });
await cp(resolve(repoRoot, "examples"), resolve(output, "examples"), { recursive: true });
