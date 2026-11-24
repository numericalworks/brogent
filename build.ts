/**
 * Builds the Brogent extension for Firefox and/or Chrome.
 *
 *   bun run build.ts                     Firefox → dist/
 *   bun run build.ts --target=firefox    Firefox → dist/
 *   bun run build.ts --target=chrome     Chrome  → dist-chrome/
 *   bun run build.ts --target=all        both
 *   bun run build.ts --watch             rebuild on changes
 *   bun run build.ts --no-sourcemap      omit source maps
 */

import { copyFile, mkdir, readdir, rm, stat } from "node:fs/promises";
import { existsSync, watch } from "node:fs";
import { join, relative } from "node:path";

type Target = "firefox" | "chrome";

const root = import.meta.dir;
const srcDir = join(root, "src");
const watchMode = process.argv.includes("--watch");
const sourcemap = process.argv.includes("--no-sourcemap") ? "none" : "inline";
const targetArg = process.argv.find((arg) => arg.startsWith("--target="))?.split("=")[1];
const targets: Target[] =
  targetArg === "all" ? ["firefox", "chrome"] : targetArg === "chrome" ? ["chrome"] : ["firefox"];

const STATIC_FILES = ["panel.html", "panel.css"];
const ICON_SIZES = [16, 32, 48, 96, 128];

function outDirFor(target: Target): string {
  return target === "chrome" ? join(root, "dist-chrome") : join(root, "dist");
}

function manifestFor(target: Target): string {
  return join(srcDir, target === "chrome" ? "manifest.chrome.json" : "manifest.firefox.json");
}

function kb(bytes: number): string {
  return `${(bytes / 1024).toFixed(1)} KB`;
}

async function copyIcons(distDir: string): Promise<void> {
  const iconsDir = join(distDir, "icons");
  await mkdir(iconsDir, { recursive: true });
  for (const size of ICON_SIZES) {
    await copyFile(join(srcDir, "icons", `icon-${size}.png`), join(iconsDir, `icon-${size}.png`));
  }
}

async function reportBundle(distDir: string): Promise<void> {
  const files = (await readdir(distDir, { recursive: true })) as string[];
  for (const file of files.sort()) {
    const path = join(distDir, file);
    if (!existsSync(path)) continue;
    const info = await stat(path);
    if (info.isFile()) console.log(`  ${relative(distDir, path).padEnd(28)} ${kb(info.size)}`);
  }
}

async function buildTarget(target: Target): Promise<void> {
  const distDir = outDirFor(target);
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
    console.error(`Build failed (${target}):`);
    for (const log of result.logs) console.error(`  ${String(log)}`);
    process.exit(1);
  }

  for (const file of STATIC_FILES) {
    await copyFile(join(srcDir, file), join(distDir, file));
  }
  await copyFile(manifestFor(target), join(distDir, "manifest.json"));
  await copyIcons(distDir);

  console.log(
    `Brogent (${target}) built in ${Math.round(performance.now() - started)} ms → ${relative(root, distDir)}/`,
  );
  await reportBundle(distDir);

  if (target === "firefox") {
    console.log("\nLoad dist/manifest.json from about:debugging#/runtime/this-firefox");
    console.log("or run `bun run dev:firefox` to launch a temporary profile.");
  } else {
    console.log("\nLoad dist-chrome/ from chrome://extensions → Developer mode → Load unpacked.");
    console.log('Enable "Allow User Scripts" on the extension details page for execute_javascript.');
  }
}

for (const target of targets) {
  await buildTarget(target);
}

if (watchMode) {
  console.log("\nWatching src/ and scripts/ for changes…");
  let timer: ReturnType<typeof setTimeout> | undefined;
  const rebuild = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      void (async () => {
        for (const target of targets) await buildTarget(target);
      })().catch((error: unknown) => console.error(error));
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
