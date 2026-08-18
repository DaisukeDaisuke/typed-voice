import test from "node:test";
import assert from "node:assert/strict";
import { resolvePairingScanRect } from "../src/app/pairing-scan-policy.js";

test("QR走査は元画素を縮小せず中央の広い領域を切り出す", () => {
  assert.deepEqual(resolvePairingScanRect(3840, 2160), {
    x: 1120,
    y: 280,
    width: 1600,
    height: 1600,
  });
  assert.deepEqual(resolvePairingScanRect(1920, 1080), {
    x: 160,
    y: 0,
    width: 1600,
    height: 1080,
  });
  assert.deepEqual(resolvePairingScanRect(1280, 720), {
    x: 0,
    y: 0,
    width: 1280,
    height: 720,
  });
});
