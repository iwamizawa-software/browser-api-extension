// Build script: bundles every entry point with esbuild and copies static files
// and the VAD / onnxruntime-web runtime assets into the output directory, so
// nothing is ever fetched from a CDN at runtime.
//
//   node scripts/build.mjs          -> dist/      (load this as an unpacked extension)
//   node scripts/build.mjs --e2e    -> dist-e2e/  (test build: Groq base URL points to a local mock)

import { build } from "esbuild";
import { randomBytes } from "node:crypto";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const e2e = process.argv.includes("--e2e");
const outdir = join(root, e2e ? "dist-e2e" : "dist");
const E2E_GROQ_BASE = process.env.E2E_GROQ_BASE ?? "http://127.0.0.1:8787/openai/v1";
const groqBase = e2e ? E2E_GROQ_BASE : "https://api.groq.com/openai/v1";

// Random per build, so the handshake tag cannot be hard-coded by page scripts
// that target this extension generically.
const magic = "bae_" + randomBytes(12).toString("hex");

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });

const common = {
  bundle: true,
  target: "chrome116",
  logLevel: "warning",
  legalComments: "none",
  minify: false,
  sourcemap: false,
  define: {
    __MAGIC__: JSON.stringify(magic),
    __GROQ_BASE__: JSON.stringify(groqBase),
  },
};

// Content scripts: IIFE so nothing leaks into the page's global scope.
await build({
  ...common,
  format: "iife",
  entryPoints: {
    "main-timers": "src/main/timers-entry.ts",
    "main-speech": "src/main/speech-entry.ts",
  },
  outdir,
  absWorkingDir: root,
});
for (const channel of ["timers", "speech"]) {
  await build({
    ...common,
    format: "iife",
    entryPoints: { [`isolated-${channel}`]: "src/isolated/relay.ts" },
    define: { ...common.define, __CHANNEL__: JSON.stringify(channel) },
    outdir,
    absWorkingDir: root,
  });
}

// Extension contexts.
await build({
  ...common,
  format: "iife",
  entryPoints: {
    sw: "src/background/sw.ts",
    "timer-worker": "src/offscreen/timer-worker.ts",
  },
  outdir,
  absWorkingDir: root,
});
await build({
  ...common,
  format: "esm",
  entryPoints: {
    offscreen: "src/offscreen/offscreen.ts",
    setup: "src/setup/setup.ts",
  },
  outdir,
  absWorkingDir: root,
});

// Static files.
for (const f of ["offscreen/offscreen.html", "setup/setup.html", "setup/setup.css"]) {
  await cp(join(root, "src", f), join(outdir, f.split("/").pop()));
}

// VAD model, AudioWorklet and onnxruntime-web wasm runtime.
const vadOut = join(outdir, "vad");
await mkdir(vadOut, { recursive: true });
const vadDist = join(root, "node_modules/@ricky0123/vad-web/dist");
const ortDist = join(root, "node_modules/onnxruntime-web/dist");
for (const f of ["silero_vad_v5.onnx", "vad.worklet.bundle.min.js"]) await cp(join(vadDist, f), join(vadOut, f));
for (const f of ["ort-wasm-simd-threaded.wasm", "ort-wasm-simd-threaded.mjs"]) await cp(join(ortDist, f), join(vadOut, f));

// Manifest.
const manifest = JSON.parse(await readFile(join(root, "src/manifest.json"), "utf8"));
const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
manifest.version = pkg.version;
if (e2e) {
  const origin = new URL(E2E_GROQ_BASE).origin;
  manifest.name += " (E2E test build)";
  manifest.host_permissions.push(`${origin}/*`);
  manifest.content_security_policy.extension_pages = manifest.content_security_policy.extension_pages.replace(
    "connect-src 'self' https://api.groq.com",
    `connect-src 'self' https://api.groq.com ${origin}`,
  );
}
await writeFile(join(outdir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");

console.log(`built ${e2e ? "E2E " : ""}extension -> ${outdir}`);
