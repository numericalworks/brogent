/**
 * Builds the Firefox extension into `dist/`.
 *
 *   bun run build.ts          one-off build
 *   bun run build.ts --watch  rebuild on changes
 */

import { copyFile, mkdir, readdir, rm, stat } from "node:fs/promises";
import { existsSync, watch } from "node:fs";
import { join, relative } from "node:path";

const root = import.meta.dir;
const srcDir = join(root, "src");
const distDir = join(root, "dist");
const watchMode = process.argv.includes("--watch");
const sourcemap = process.argv.includes("--no-sourcemap") ? "none" : "inline";

const STATIC_FILES = ["manifest.json", "panel.html", "panel.css"];
const ICON_SIZES = [48, 96, 128];

function kb(bytes: number): string {
  return `${(bytes / 1024).toFixed(1)} KB`;
}

async function copyIcons(): Promise<void> {
  const iconsDir = join(distDir, "icons");
  await mkdir(iconsDir, { recursive: true });
  for (const size of ICON_SIZES) {
    await copyFile(join(srcDir, "icons", `icon-${size}.png`), join(iconsDir, `icon-${size}.png`));
  }
}

async function reportBundle(): Promise<void> {
  const files = (await readdir(distDir, { recursive: true })) as string[];
  for (const file of files.sort()) {
    const path = join(distDir, file);
    if (!existsSync(path)) continue;
    const info = await stat(path);
    if (info.isFile()) console.log(`  ${relative(distDir, path).padEnd(28)} ${kb(info.size)}`);
  }
}

async function build(): Promise<void> {
  const started = performance.now();

  await rm(distDir, { recursive: true, force: true });
  await mkdir(distDir, { recursive: true });

  const result = await Bun.build({
    entrypoints: [join(srcDir, "background.ts"), join(srcDir, "panel.ts")],
    outdir: distDir,
    target: "browser",
    format: "iife",
    sourcemap,
    minify: false,
    naming: "[name].js",
  });

  if (!result.success) {
    console.error("Build failed:");
    for (const log of result.logs) console.error(`  ${String(log)}`);
    process.exit(1);
  }

  for (const file of STATIC_FILES) {
    await copyFile(join(srcDir, file), join(distDir, file));
  }
  await copyIcons();

  console.log(`Brogent built in ${Math.round(performance.now() - started)} ms → dist/`);
  await reportBundle();
  console.log("\nLoad dist/manifest.json from about:debugging#/runtime/this-firefox");
  console.log("or run `bun run dev:firefox` to launch a temporary profile.");
}

await build();

if (watchMode) {
  console.log("\nWatching src/ and scripts/ for changes…");
  let timer: ReturnType<typeof setTimeout> | undefined;
  const rebuild = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      void build().catch((error: unknown) => console.error(error));
    }, 120);
  };

  try {
    for (const directory of [srcDir, join(root, "scripts")]) {
      watch(directory, { recursive: true }, rebuild);
    }
  } catch (error) {
    console.warn("Watch mode is unavailable on this platform:", error);
  }
}
