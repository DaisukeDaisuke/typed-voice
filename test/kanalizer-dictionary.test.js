import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createKanalizerDictionary } from "../src/text/kanalizer-dictionary.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const indexBytes = fs.readFileSync(path.join(root, "src/kanalizer-dictionary/dictionary.idx"));
const stringBytes = fs.readFileSync(path.join(root, "src/kanalizer-dictionary/dictionary.str"));
const dictionary = createKanalizerDictionary(
  indexBytes.buffer.slice(indexBytes.byteOffset, indexBytes.byteOffset + indexBytes.byteLength),
  stringBytes.buffer.slice(stringBytes.byteOffset, stringBytes.byteOffset + stringBytes.byteLength),
);

test("Kanalizer v3辞書はWebAssemblyを既知語2件へ分割する", () => {
  assert.deepEqual(dictionary.segment("WebAssembly"), [
    { source: "Web", reading: "ウェブ", known: true },
    { source: "Assembly", reading: "アセンブリー", known: true },
  ]);
});

test("Kanalizer v3辞書は長い既知語を短い候補より優先する", () => {
  assert.deepEqual(dictionary.segment("GitHubActions"), [
    { source: "GitHub", reading: "ギットハブ", known: true },
    { source: "Actions", reading: "アクションズ", known: true },
  ]);
});

test("1〜2文字辞書を通常分割へ使わず未知spanとして残す", () => {
  assert.deepEqual(dictionary.segment("WebGPU"), [
    { source: "Web", reading: "ウェブ", known: true },
    { source: "gpu", reading: null, known: false },
  ]);
  assert.deepEqual(dictionary.segment("NodeJS"), [
    { source: "Node", reading: "ノード", known: true },
    { source: "js", reading: null, known: false },
  ]);
});
