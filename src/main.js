import "./style.css";
import { UiOrchestrator } from "./app/ui-orchestrator.js";
import { VoiceRuntimeAdapter } from "./app/voice-runtime-adapter.js";
import { requireServiceWorker } from "./app/service-worker-required.js";
import { initializeModelProfileUi } from "./app/model-profile-ui.js";
import { resolveStartupTutorialProfile, TutorialController } from "./app/tutorial.js";
import { initializeBackupUi } from "./app/backup-ui.js";
import { createBlockingTaskOrchestrator } from "./app/blocking-task-orchestrator.js";
import { reconcileTutorialPersistence } from "./app/tutorial-persistence.js";
import { initializeOfflineRuntimeResetUi } from "./app/offline-runtime-reset.js";

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
const selectedModelCached = await blocking.registerBlockingAsync("音声キャッシュ", async ({ report }) => {
  report({ detail: "選択中の音声モデルがこの端末に保存済みかService Workerへ確認しています。" });
  return app.isVoiceProfileCached(modelProfileUi.profile);
});
await blocking.registerBlockingAsync("操作画面", async ({ report }) => {
  report({ detail: "バックアップとチュートリアルを準備しています。" });
  initializeBackupUi(document, { app, modelProfileUi });
  const offlineRuntimeResetUi = initializeOfflineRuntimeResetUi(document, { db: app.repository?.db });
  globalThis.typedVoiceDebug = Object.assign(globalThis.typedVoiceDebug ?? {}, {
    showOfflineResetFreeze: () => offlineRuntimeResetUi.showFreeze(),
  });
  const tutorial = new TutorialController(document, {
    modelProfileUi,
    app,
    tutorialComplete: tutorialState.complete,
  }).initialize();

  const endTutorialProfile = Object.freeze({
    terminal: true,
  });

  const fullTutorialProfile = Object.freeze({
    route: "all",
    headerBrand: "はじめての typed-voice",
    completionLabel: "使い始める",
    completeTo: "end",
    lockBackDuringModelLoad: true,
    onOpen({ controller, modelProfileUi: profileUi }) {
      if (!controller.tutorialComplete) profileUi.select("fp16", { persist: false });
    },
    async onStageChange({ discardPending }) {
      await discardPending();
    },
    async onEnterStep({ stepId, app: tutorialApp }) {
      if (stepId === "model-load") await tutorialApp.finishTutorialData();
    },
    async onComplete({ controller, app: tutorialApp, modelProfileUi: profileUi }) {
      profileUi.commitSelection();
      await tutorialApp.markTutorialComplete();
      controller.tutorialComplete = true;
    },
  });

  const modelPickerRoute = Object.freeze([
      Object.freeze({ step: "model", id: "choose-model", nextLabel: "容量を確認する" }),
      Object.freeze({ step: "download", id: "download-model", nextLabel: "ダウンロード完了", backLabel: "モデル選択へ戻る" }),
      Object.freeze({ step: "download-ready", id: "download-ready", nextLabel: "モデルを読み込む", backLabel: "ダウンロードへ戻る" }),
      Object.freeze({ step: "model-load", id: "load-model", nextLabel: "モデル変更を完了", backLabel: "戻る" }),
  ]);
  const modelPickerOpen = ({ modelProfileUi: profileUi, state }) => {
    state.completed = false;
    profileUi.restoreCommittedSelection();
  };
  const modelPickerComplete = ({ modelProfileUi: profileUi, state }) => {
    profileUi.commitSelection();
    state.completed = true;
  };

  const modelPickerProfile = Object.freeze({
    route: modelPickerRoute,
    headerBrand: "音声モデルを変更",
    completionLabel: "モデル変更を完了",
    completeTo: "end",
    cancelTo: "end",
    closeOnBackAtStart: true,
    lockBackDuringModelLoad: true,
    onOpen: modelPickerOpen,
    onComplete: modelPickerComplete,
    async onClose({ state, restoreCommittedModel }) {
      if (!state.completed) await restoreCommittedModel();
    },
  });

  const requiredModelPickerProfile = Object.freeze({
    route: modelPickerRoute,
    headerBrand: "音声モデルを準備",
    completionLabel: "モデル変更を完了",
    completeTo: "end",
    closeOnBackAtStart: false,
    lockBackDuringModelLoad: true,
    onOpen: modelPickerOpen,
    onComplete: modelPickerComplete,
  });

  tutorial
    .registerProfile("end", endTutorialProfile)
    .registerProfile("full", fullTutorialProfile)
    .registerProfile("model-picker", modelPickerProfile)
    .registerProfile("model-picker-required", requiredModelPickerProfile);

  await tutorial.openProfile(resolveStartupTutorialProfile({
    tutorialComplete: tutorialState.complete,
    selectedModelCached,
  }));

  document.getElementById("settings-model-picker")?.addEventListener("click", () => {
    modelProfileUi.closeSettings();
    void tutorial.openProfile("model-picker");
  });
});
blocking.finish();
if (tutorialState.complete && selectedModelCached) {
  void app.initializePreparedVoice(modelProfileUi.profile, { enableAudio: false }).catch(() => {});
}


