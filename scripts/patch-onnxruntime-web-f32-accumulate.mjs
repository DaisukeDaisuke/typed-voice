import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const EXPECTED_ORT_VERSION = "1.27.0";
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const ortRoot = join(root, "node_modules", "onnxruntime-web");
const ortPackagePath = join(ortRoot, "package.json");
const targetPath = join(ortRoot, "dist", "ort.all.bundle.min.mjs");

const ortPackage = JSON.parse(await readFile(ortPackagePath, "utf8"));
if (ortPackage.version !== EXPECTED_ORT_VERSION) {
  throw new Error(
    `Refusing to patch onnxruntime-web ${ortPackage.version}; expected ${EXPECTED_ORT_VERSION}. `
      + "Review the upstream WebGPU MatMul implementation before changing this pin."
  );
}

const replacements = [
  ["var acc: array<vec4<${n}>, rowPerThread>;", "var acc: array<vec4<f32>, rowPerThread>;", 1],
  [
    "var acc : array<array<${n}, colPerThread>, rowPerThread>;",
    "var acc : array<array<f32, colPerThread>, rowPerThread>;",
    1,
  ],
  ["BCached0 * ACached0[i] + acc[i]", "vec4<f32>(BCached0) * f32(ACached0[i]) + acc[i]", 1],
  ["BCached1 * ACached1[i] + acc[i]", "vec4<f32>(BCached1) * f32(ACached1[i]) + acc[i]", 1],
  ["BCached2 * ACached2[i] + acc[i]", "vec4<f32>(BCached2) * f32(ACached2[i]) + acc[i]", 1],
  ["BCached3 * ACached3[i] + acc[i]", "vec4<f32>(BCached3) * f32(ACached3[i]) + acc[i]", 1],
  ["BCached0 * ACached.x + acc[i]", "vec4<f32>(BCached0) * f32(ACached.x) + acc[i]", 1],
  ["BCached1 * ACached.y + acc[i]", "vec4<f32>(BCached1) * f32(ACached.y) + acc[i]", 1],
  ["BCached2 * ACached.z + acc[i]", "vec4<f32>(BCached2) * f32(ACached.z) + acc[i]", 1],
  ["BCached3 * ACached.w + acc[i]", "vec4<f32>(BCached3) * f32(ACached.w) + acc[i]", 1],
  ["ACached * BCached[innerCol]", "f32(ACached) * f32(BCached[innerCol])", 2],
  [
    "mm_write(batch, globalRow + innerRow, globalCol, acc[innerRow]);",
    "mm_write(batch, globalRow + innerRow, globalCol, vec4<${n}>(acc[innerRow]));",
    1,
  ],
  [
    "mm_write(batch, gRow, gCol, acc[innerRow][innerCol]);",
    "mm_write(batch, gRow, gCol, ${n}(acc[innerRow][innerCol]));",
    1,
  ],
  [
    "mm_write(batch, globalRow + innerRow, globalCol + innerCol,\n        acc[innerRow][innerCol]);",
    "mm_write(batch, globalRow + innerRow, globalCol + innerCol,\n        ${n}(acc[innerRow][innerCol]));",
    1,
  ],
];

const countOccurrences = (text, needle) => text.split(needle).length - 1;

let source = await readFile(targetPath, "utf8");
const originalCounts = replacements.map(([from]) => countOccurrences(source, from));

if (originalCounts.every((count) => count === 0)) {
  const patchedCounts = replacements.map(([, to]) => countOccurrences(source, to));
  const complete = patchedCounts.every((count, index) => count === replacements[index][2]);
  if (!complete) {
    throw new Error(
      "onnxruntime-web WebGPU MatMul bundle is neither the expected upstream form nor the fully patched form."
    );
  }
  console.log(`onnxruntime-web ${EXPECTED_ORT_VERSION} WebGPU FP32-accumulate patch already applied.`);
  process.exit(0);
}

for (let index = 0; index < replacements.length; index += 1) {
  const [from, to, expectedCount] = replacements[index];
  const actualCount = originalCounts[index];
  if (actualCount !== expectedCount) {
    throw new Error(
      `Unexpected onnxruntime-web bundle shape for replacement ${index + 1}: `
        + `expected ${expectedCount}, found ${actualCount}.`
    );
  }
  source = source.split(from).join(to);
}

await writeFile(targetPath, source, "utf8");

for (let index = 0; index < replacements.length; index += 1) {
  const [from, to, expectedCount] = replacements[index];
  const originalCount = countOccurrences(source, from);
  const patchedCount = countOccurrences(source, to);
  if (originalCount !== 0 || patchedCount !== expectedCount) {
    throw new Error(
      `Failed to verify onnxruntime-web replacement ${index + 1}: `
        + `original=${originalCount}, patched=${patchedCount}, expected=${expectedCount}.`
    );
  }
}

console.log(
  `Patched onnxruntime-web ${EXPECTED_ORT_VERSION}: packed WebGPU MatMul now accumulates in FP32 `
    + "while retaining FP16 inputs, weights, and outputs."
);
