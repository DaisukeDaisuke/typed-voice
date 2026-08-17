import test from "node:test";
import assert from "node:assert/strict";
import { ModelProfileUi } from "../src/app/model-profile-ui.js";

function createStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); },
    snapshot() { return Object.fromEntries(values); },
  };
}

function createDocumentStub() {
  return {
    dispatchEvent() {},
  };
}

test("tutorial内のモデル選択はcommitまで永続設定を変更しない", () => {
  const storage = createStorage({ "typed-voice-ui-model-profile-v1": "fp16" });
  const ui = new ModelProfileUi(createDocumentStub(), storage);

  ui.select("fp32", { persist: false });
  assert.equal(ui.profile, "fp32");
  assert.equal(ui.committedProfile, "fp16");
  assert.equal(storage.snapshot()["typed-voice-ui-model-profile-v1"], "fp16");

  ui.commitSelection();
  assert.equal(ui.committedProfile, "fp32");
  assert.equal(storage.snapshot()["typed-voice-ui-model-profile-v1"], "fp32");
});

test("未確定モデルはrestoreで最後に確定したモデルへ戻る", () => {
  const storage = createStorage({ "typed-voice-ui-model-profile-v1": "mobile-int8" });
  const ui = new ModelProfileUi(createDocumentStub(), storage);

  ui.select("mobile-int4", { persist: false });
  assert.equal(ui.profile, "mobile-int4");
  ui.restoreCommittedSelection();

  assert.equal(ui.profile, "mobile-int8");
  assert.equal(ui.committedProfile, "mobile-int8");
  assert.equal(storage.snapshot()["typed-voice-ui-model-profile-v1"], "mobile-int8");
});

