import test from "node:test";
import assert from "node:assert/strict";
import { NoVoiceRuntime } from "../src/app/no-voice-runtime.js";

test("クライアントモードの音声なしランタイムはローカルモデルを準備しない", async () => {
  const runtime = new NoVoiceRuntime();
  assert.equal(await runtime.isProfilePrepared("fp16"), false);
  assert.deepEqual(await runtime.synthesize({ text: "テスト" }), { skipped: true, durationMs: 0 });
  await assert.rejects(() => runtime.prepare("fp16"), /この端末の音声モデルを使用しません/);
  await assert.rejects(() => runtime.initializePrepared("fp16"), /この端末の音声モデルを使用しません/);
});
