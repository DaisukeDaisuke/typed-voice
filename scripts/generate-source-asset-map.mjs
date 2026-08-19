import { createReadStream } from "node:fs";
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { extname, join, relative, resolve, sep } from "node:path";
import { createXXHash128 } from "hash-wasm";

const outputDirectory = resolve(process.argv[2] || "dist");
const outputFileName = "source-asset-map.json";
const excludedFiles = new Set([
  outputFileName,
  "app-service-worker.js",
  ".vite/manifest.json",
]);

const viteManifestPath = join(outputDirectory, ".vite", "manifest.json");

function collectManifestFiles(viteManifest, rootKey, { includeDynamic = false } = {}) {
  const files = new Set();
  const visited = new Set();
  const visit = (key) => {
    if (!key || visited.has(key)) return;
    visited.add(key);
    const entry = viteManifest[key];
    if (!entry) return;
    if (entry.file) files.add(entry.file);
    for (const css of entry.css || []) files.add(css);
    for (const asset of entry.assets || []) files.add(asset);
    for (const imported of entry.imports || []) visit(imported);
    if (includeDynamic) {
      for (const imported of entry.dynamicImports || []) visit(imported);
    }
  };
  visit(rootKey);
  return files;
}

function findManifestKey(viteManifest, suffix) {
  return Object.entries(viteManifest).find(([key, entry]) => (
    key === suffix
    || key.endsWith(`/${suffix}`)
    || entry?.src === suffix
    || String(entry?.src || "").endsWith(`/${suffix}`)
  ))?.[0] || null;
}

function classifyAsset(path, sets) {
  if (sets.core.has(path) || path === "index.html" || path === "worker.html" || path === "voice-manifest.json") return "core";
  if (sets.client.has(path)) return "client";
  if (sets.engine.has(path)
    || /(?:^|\/)(?:engine(?:\.worker|-client)|kanalizer-normalizer)-/i.test(path)
    || /(?:^|\/)(?:ort-wasm|kanalizer_browser_bg|dictionary-)/i.test(path)
    || /^ort-wasm.*\.(?:mjs|wasm)$/i.test(path)) return "engine";
  return "optional";
}

async function listFiles(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await listFiles(path));
    else if (entry.isFile()) result.push(path);
  }
  return result;
}

async function xxh3_128File(path) {
  const hasher = await createXXHash128();
  for await (const chunk of createReadStream(path)) hasher.update(chunk);
  return hasher.digest();
}

function portablePath(path) {
  return path.split(sep).join("/");
}

const viteManifest = JSON.parse(await readFile(viteManifestPath, "utf8"));
const indexKey = findManifestKey(viteManifest, "index.html");
const workerKey = findManifestKey(viteManifest, "worker.html");
const engineKey = findManifestKey(viteManifest, "src/app/voice-runtime-adapter.js");
const clientKey = findManifestKey(viteManifest, "src/app/remote-voice-runtime.js");
const groups = {
  core: collectManifestFiles(viteManifest, indexKey),
  engine: collectManifestFiles(viteManifest, engineKey, { includeDynamic: true }),
  client: collectManifestFiles(viteManifest, clientKey, { includeDynamic: true }),
};
for (const file of collectManifestFiles(viteManifest, workerKey)) groups.core.add(file);

// main.js dynamically imports one thin runtime adapter before the tutorial can
// be shown. Those adapters and their *static* dependency graphs are therefore
// bootstrap code, not deferred engine/client payloads. Their own dynamic
// imports (EngineClient, Kanalizer, ORT, etc.) stay in engine/client and remain
// behind the user's download/update consent.
for (const bootstrapKey of [engineKey, clientKey]) {
  for (const file of collectManifestFiles(viteManifest, bootstrapKey)) groups.core.add(file);
}
for (const file of groups.core) {
  groups.engine.delete(file);
  groups.client.delete(file);
}

const assets = {};
const files = (await listFiles(outputDirectory))
  .map((path) => ({ path, relativePath: portablePath(relative(outputDirectory, path)) }))
  .filter(({ relativePath }) => !excludedFiles.has(relativePath))
  .sort((left, right) => left.relativePath.localeCompare(right.relativePath, "en"));

for (const file of files) {
  const info = await stat(file.path);
  assets[file.relativePath] = {
    byteSize: info.size,
    extension: extname(file.relativePath).toLowerCase(),
    group: classifyAsset(file.relativePath, groups),
    xxh3_128: await xxh3_128File(file.path),
  };
}

const generationHasher = await createXXHash128();
generationHasher.update(new TextEncoder().encode(JSON.stringify(assets)));
const generation = generationHasher.digest();

const manifest = {
  version: 2,
  algorithm: "xxh3-128",
  generation,
  assets,
};

await writeFile(
  join(outputDirectory, outputFileName),
  `${JSON.stringify(manifest, null, 2)}\n`,
  "utf8",
);

console.log(`Generated ${outputFileName} for ${Object.keys(assets).length} assets.`);
