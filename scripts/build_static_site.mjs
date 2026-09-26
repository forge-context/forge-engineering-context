import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { LOCALES, PATHS, SITE } from "../site/copy.mjs";
import { renderPage } from "../site/page.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = resolve(repoRoot, "dist");

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });

// One page per locale, all from the same template: `/` (Japanese), `/zh/`, `/en/`.
for (const locale of LOCALES) {
  const directory = resolve(output, `.${PATHS[locale]}`);
  await mkdir(directory, { recursive: true });
  await writeFile(resolve(directory, "index.html"), renderPage(locale));
}

// og-image.svg stays in the repository as the editable source; only the rendered PNG ships.
const staticFiles = [
  "styles.css",
  "script.js",
  "demo.js",
  "demo-model.js",
  "public-config.js",
  "README.md",
  "favicon.svg",
  "favicon.png",
  "og-image.png",
  "robots.txt",
];
for (const source of staticFiles) {
  await cp(resolve(repoRoot, source), resolve(output, source));
}
await cp(resolve(repoRoot, "docs"), resolve(output, "docs"), { recursive: true });
await cp(resolve(repoRoot, "examples"), resolve(output, "examples"), { recursive: true });

// Japanese is served at `/`; `/ja/` is kept as a stable alias for links that follow
// the jianguoding.com `/ja/` convention.
await writeFile(resolve(output, "_redirects"), "/ja /  301\n/ja/ /  301\n");

const today = new Date().toISOString().slice(0, 10);
const urls = LOCALES.map((locale) => `  <url>\n    <loc>${SITE}${PATHS[locale]}</loc>\n    <lastmod>${today}</lastmod>\n  </url>`);
await writeFile(
  resolve(output, "sitemap.xml"),
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join("\n")}\n</urlset>\n`,
);
