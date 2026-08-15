import { cp, mkdir, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const source = join(root, "node_modules", "onnxruntime-web", "dist");
const destination = join(root, "public");

await mkdir(destination, { recursive: true });
const files = await readdir(source);
const runtimeFiles = files.filter(
  (name) => name.startsWith("ort-wasm") && (name.endsWith(".wasm") || name.endsWith(".mjs"))
);

if (runtimeFiles.length === 0) {
  throw new Error(`No ONNX Runtime Web WASM assets found in ${source}`);
}

await Promise.all(runtimeFiles.map((name) => cp(join(source, name), join(destination, name))));

await Promise.all([
  cp(join(root, "LICENSE"), join(destination, "LICENSE.txt")),
  cp(join(root, "NOTICE"), join(destination, "NOTICE.txt")),
  cp(join(root, "THIRD_PARTY_NOTICES.md"), join(destination, "THIRD_PARTY_NOTICES.md")),
  mkdir(join(destination, "licenses"), { recursive: true }).then(() =>
    cp(join(root, "licenses"), join(destination, "licenses"), { recursive: true })
  ),
]);

console.log(`Copied ${runtimeFiles.length} ONNX Runtime Web runtime assets and legal notices.`);
