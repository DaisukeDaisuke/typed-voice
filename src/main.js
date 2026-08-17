import "./style.css";
import { UiOrchestrator } from "./app/ui-orchestrator.js";
import { VoiceRuntimeAdapter } from "./app/voice-runtime-adapter.js";
import { requireServiceWorker } from "./app/service-worker-required.js";
import { initializeModelProfileUi } from "./app/model-profile-ui.js";
import { TutorialController } from "./app/tutorial.js";
import { initializeBackupUi } from "./app/backup-ui.js";
import { createBlockingTaskOrchestrator } from "./app/blocking-task-orchestrator.js";
import { reconcileTutorialPersistence } from "./app/tutorial-persistence.js";

const blocking = createBlockingTaskOrchestrator(document);
await blocking.registerBlockingAsync("Service Worker", async ({ report }) => {
  report({ detail: "オフライン実行の準備を確認しています。" });
  await requireServiceWorker({ reloadKey: "typed-voice-app-coi-reloaded" });
});
const tutorialState = await blocking.registerBlockingAsync("保存状態", async ({ report }) => {
  report({ detail: "チュートリアルと会話データの状態を確認しています。" });
  return reconcileTutorialPersistence();
});
const voiceStatus = document.querySelector("#voice-status");
const manifestUrl = new URL(`${import.meta.env.BASE_URL}voice-manifest.json`, document.baseURI).href;
const appBaseUrl = new URL(import.meta.env.BASE_URL, document.baseURI).href;
const voiceRuntime = new VoiceRuntimeAdapter({
  manifestUrl,
  appBaseUrl,
  onStatus(message) {
    voiceStatus.textContent = message;
  },
});
const modelProfileUi = await blocking.registerBlockingAsync("画面設定", async ({ report }) => {
  report({ detail: "保存済みの音声設定を読み込んでいます。" });
  return initializeModelProfileUi(document);
});
const app = new UiOrchestrator(document, {
  voiceRuntime,
  getModelProfile: () => modelProfileUi.profile,
});
await blocking.registerBlockingAsync("会話データ", async ({ report }) => {
  report({ detail: "会話データベースを開いています。" });
  await app.initialize();
});
await blocking.registerBlockingAsync("操作画面", async ({ report }) => {
  report({ detail: "バックアップとチュートリアルを準備しています。" });
  initializeBackupUi(document, { app, modelProfileUi });
  new TutorialController(document, {
    modelProfileUi,
    app,
    tutorialComplete: tutorialState.complete,
  }).initialize();
});
const selectedModelCached = await blocking.registerBlockingAsync("音声キャッシュ", async ({ report }) => {
  report({ detail: "選択中の音声モデルがこの端末に保存済みか確認しています。" });
  return app.isVoiceProfileCached(modelProfileUi.profile);
});
blocking.finish();
if (tutorialState.complete && selectedModelCached) {
  void app.initializePreparedVoice(modelProfileUi.profile, { enableAudio: false }).catch(() => {});
}


