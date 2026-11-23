/**
 * Packages `dist/` into `brogent.xpi` (a plain ZIP, which is what Firefox
 * expects). Run `bun run build` first, or use `bun run package`.
 */

import { existsSync } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { createZip, type ZipEntry } from "./zip";

const root = join(import.meta.dir, "..");
const distDir = join(root, "dist");
const target = join(root, "brogent.xpi");

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
  console.error("dist/manifest.json is missing. Run `bun run build` first.");
  process.exit(1);
}

const entries: ZipEntry[] = [];
await collect(distDir, entries);

const zip = createZip(entries);
await writeFile(target, zip);

console.log(`Packaged ${entries.length} files → brogent.xpi (${(zip.length / 1024).toFixed(1)} KB)`);
console.log("Install it in Firefox via about:addons → gear icon → Install Add-on From File…");
