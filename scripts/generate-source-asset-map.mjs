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
  if (sets.core.has(path) || path === "index.html") return "core";
  if (sets.client.has(path)) return "client";
  if (sets.engine.has(path)
    || /(?:^|\/)(?:engine(?:\.worker|-client)|voice-runtime-adapter|kanalizer-normalizer)-/i.test(path)
    || /(?:^|\/)(?:ort-wasm|kanalizer_browser_bg|dictionary-)/i.test(path)
    || path === "voice-manifest.json"
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
const engineKey = findManifestKey(viteManifest, "src/app/voice-runtime-adapter.js");
const clientKey = findManifestKey(viteManifest, "src/app/remote-voice-runtime.js");
const groups = {
  core: collectManifestFiles(viteManifest, indexKey),
  engine: collectManifestFiles(viteManifest, engineKey, { includeDynamic: true }),
  client: collectManifestFiles(viteManifest, clientKey, { includeDynamic: true }),
};
groups.engine.delete(viteManifest[engineKey]?.file);
groups.client.delete(viteManifest[clientKey]?.file);
if (viteManifest[engineKey]?.file) groups.engine.add(viteManifest[engineKey].file);
if (viteManifest[clientKey]?.file) groups.client.add(viteManifest[clientKey].file);

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
