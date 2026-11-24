/**
 * Packages a built extension into a ZIP.
 *
 *   bun run scripts/package.ts           dist/        → brogent.xpi
 *   bun run scripts/package.ts --chrome  dist-chrome/ → brogent-chrome.zip
 */

import { existsSync } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { createZip, type ZipEntry } from "./zip";

const root = join(import.meta.dir, "..");
const chrome = process.argv.includes("--chrome");
const distDir = join(root, chrome ? "dist-chrome" : "dist");
const target = join(root, chrome ? "brogent-chrome.zip" : "brogent.xpi");

async function collect(dir: string, entries: ZipEntry[]): Promise<void> {
  const items = await readdir(dir, { withFileTypes: true });
  for (const item of items.sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(dir, item.name);
    if (item.isDirectory()) {
      await collect(path, entries);
    } else if (item.isFile()) {
      entries.push({
        name: relative(distDir, path).split(sep).join("/"),
        data: new Uint8Array(await readFile(path)),
      });
    }
  }
}

if (!existsSync(join(distDir, "manifest.json"))) {
  const command = chrome ? "bun run build:chrome" : "bun run build";
  console.error(`${relative(root, distDir)}/manifest.json is missing. Run \`${command}\` first.`);
  process.exit(1);
}

const entries: ZipEntry[] = [];
await collect(distDir, entries);

const zip = createZip(entries);
await writeFile(target, zip);

console.log(
  `Packaged ${entries.length} files → ${relative(root, target)} (${(zip.length / 1024).toFixed(1)} KB)`,
);

if (chrome) {
  console.log("Load dist-chrome/ unpacked via chrome://extensions → Developer mode → Load unpacked,");
  console.log("or upload brogent-chrome.zip to the Chrome Web Store.");
} else {
  console.log("Install it in Firefox via about:addons → gear icon → Install Add-on From File…");
}
