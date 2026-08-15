import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { IncrementalSha256 } from "../src/engine/incremental-sha256.js";

function nodeDigest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

test("SHA-256を複数chunkで更新しても単一bufferと同じdigestになる", () => {
  const bytes = Uint8Array.from({ length: 257 }, (_, index) => (index * 73 + 19) & 0xff);
  const hasher = new IncrementalSha256();
  hasher.update(bytes.subarray(0, 1));
  hasher.update(bytes.subarray(1, 63));
  hasher.update(bytes.subarray(63, 64));
  hasher.update(bytes.subarray(64, 129));
  hasher.update(bytes.subarray(129));
  assert.equal(hasher.digestHex(), nodeDigest(bytes));
});

test("空入力と64-byte境界でも標準SHA-256と一致する", () => {
  for (const length of [0, 64, 128]) {
    const bytes = Uint8Array.from({ length }, (_, index) => index & 0xff);
    const hasher = new IncrementalSha256();
    hasher.update(bytes);
    assert.equal(hasher.digestHex(), nodeDigest(bytes));
  }
});
