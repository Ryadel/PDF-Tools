// Builds the two bundles (extension host + webview) and copies the runtime
// assets the webview needs (PDF.js worker, fonts, CMaps, WASM decoders, CSS).
//
// Usage: node scripts/build.mjs [--production] [--watch]

import * as esbuild from "esbuild";
import { cp, mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

const dist = join(root, "dist");
const webviewDist = join(dist, "webview");
const pdfjs = join(root, "node_modules", "pdfjs-dist");
const codicons = join(root, "node_modules", "@vscode", "codicons", "dist");

/**
 * Prints build results in the format of the `$esbuild-watch` problem matcher
 * (extension `connor4312.esbuild-problem-matchers`), used by .vscode/tasks.json.
 * @type {esbuild.Plugin}
 */
const problemMatcherPlugin = {
  name: "esbuild-problem-matcher",
  setup(build) {
    build.onStart(() => {
      console.log("[watch] build started");
    });
    build.onEnd((result) => {
      for (const { text, location } of result.errors) {
        console.error(`✘ [ERROR] ${text}`);
        if (location) {
          console.error(`    ${location.file}:${location.line}:${location.column}:`);
        }
      }
      console.log("[watch] build finished");
    });
  },
};

/** @type {esbuild.BuildOptions} */
const extensionOptions = {
  entryPoints: [join(root, "src", "extension.ts")],
  outfile: join(dist, "extension.js"),
  bundle: true,
  format: "cjs",
  platform: "node",
  target: "node20",
  external: ["vscode"],
  sourcemap: !production,
  sourcesContent: false,
  minify: production,
  logLevel: "silent",
  plugins: [problemMatcherPlugin],
};

/** @type {esbuild.BuildOptions} */
const webviewOptions = {
  entryPoints: [join(root, "webview", "main.ts")],
  outfile: join(webviewDist, "main.js"),
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  sourcemap: !production,
  sourcesContent: false,
  minify: production,
  logLevel: "silent",
  plugins: [problemMatcherPlugin],
};

async function copyAssets() {
  await mkdir(webviewDist, { recursive: true });
  const copies = [
    // The worker is loaded through a Blob URL at runtime (see webview/worker.ts).
    [join(pdfjs, "build", production ? "pdf.worker.min.mjs" : "pdf.worker.mjs"), join(webviewDist, "pdf.worker.mjs")],
    [join(pdfjs, "web", "pdf_viewer.css"), join(webviewDist, "pdf_viewer.css")],
    [join(pdfjs, "web", "images"), join(webviewDist, "images")],
    [join(pdfjs, "standard_fonts"), join(webviewDist, "standard_fonts")],
    [join(pdfjs, "cmaps"), join(webviewDist, "cmaps")],
    [join(pdfjs, "iccs"), join(webviewDist, "iccs")],
    [join(codicons, "codicon.css"), join(webviewDist, "codicons", "codicon.css")],
    [join(codicons, "codicon.ttf"), join(webviewDist, "codicons", "codicon.ttf")],
    // License texts shipped with the bundled third-party code (see THIRD_PARTY_NOTICES.md).
    [join(pdfjs, "LICENSE"), join(webviewDist, "LICENSE_PDFJS")],
    [join(codicons, "..", "LICENSE"), join(webviewDist, "codicons", "LICENSE")],
    [join(root, "webview", "styles.css"), join(webviewDist, "styles.css")],
  ];
  for (const [from, to] of copies) {
    await cp(from, to, { recursive: true });
  }
  // WASM decoders (JPEG 2000, JBIG2, color management) and their licenses only;
  // the JS fallbacks and the QuickJS scripting engine (PDF JavaScript, which
  // PDF Tools does not run) are left out.
  await cp(join(pdfjs, "wasm"), join(webviewDist, "wasm"), {
    recursive: true,
    filter: (src) => !src.endsWith(".js") && !src.includes("quickjs"),
  });
}

await rm(dist, { recursive: true, force: true });
await copyAssets();

if (watch) {
  const contexts = await Promise.all([esbuild.context(extensionOptions), esbuild.context(webviewOptions)]);
  await Promise.all(contexts.map((context) => context.watch()));
} else {
  try {
    await Promise.all([esbuild.build(extensionOptions), esbuild.build(webviewOptions)]);
  } catch {
    process.exitCode = 1; // Errors were already printed by the problem matcher plugin.
  }
}
