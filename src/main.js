import "./style.css";
import { UiOrchestrator } from "./app/ui-orchestrator.js";
import {
  applySourceAssets,
  planSourceAssets,
  readStoredSourceGeneration,
  requireServiceWorker,
  readServiceWorkerRequestLog,
  unregisterTypedVoiceServiceWorker,
  verifyStoredSourceAssets,
} from "./app/service-worker-required.js";
import { initializeModelProfileUi } from "./app/model-profile-ui.js";
import { resolveStartupTutorialProfile, TutorialController } from "./app/tutorial.js";
import { initializeBackupUi } from "./app/backup-ui.js";
import { createBlockingTaskOrchestrator } from "./app/blocking-task-orchestrator.js";
import { reconcileTutorialPersistence } from "./app/tutorial-persistence.js";
import { initializeOfflineRuntimeResetUi } from "./app/offline-runtime-reset.js";
import { initializeRemoteModeUi } from "./app/remote-mode-ui.js";
import { NoVoiceRuntime } from "./app/no-voice-runtime.js";

const debugLogLines = [];
globalThis.debug = (name, result) => {
  const time = new Date().toTimeString().slice(0, 8);
  debugLogLines.push(`${time} ${String(name)} ${String(result)}`);
};

const sourceUpdateCloseChannel = "BroadcastChannel" in globalThis
  ? new BroadcastChannel("typed-voice-source-update-close")
  : null;
sourceUpdateCloseChannel?.addEventListener("message", (event) => {
  if (event.data === "close") globalThis.close();
});

function closeOtherTabsForSourceUpdate() {
  sourceUpdateCloseChannel?.postMessage("close");
}

const FULL_TUTORIAL_ROUTE = Object.freeze([
  "about",
  "model",
  "scroll",
  "tsukuyomichan",
  "linebreak",
  "correction",
  "wait",
  "cancel",
  "conversations",
  "conversation-open",
  "finish",
  "download",
  "download-ready",
  "model-load",
  "free",
  "offline-ready",
]);

async function renderRuntimeDebug(output) {
  const scopeUrl = new URL(import.meta.env.BASE_URL, document.baseURI);
  const cacheNames = (await caches.keys()).sort();
  const metadataCache = cacheNames.includes("typed-voice-source-metadata-v1")
    ? await caches.open("typed-voice-source-metadata-v1")
    : null;
  const reviewResponse = metadataCache
    ? await metadataCache.match(new URL("__typed_voice_source/latest-review.json", scopeUrl).href)
    : null;
  const manifest = await reviewResponse?.json().catch(() => null);
  const generation = /^[0-9a-f]{32}$/i.test(String(manifest?.generation || ""))
    ? String(manifest.generation).toLowerCase()
    : null;
  const requestLog = await readServiceWorkerRequestLog();

  const lines = [
    "typed-voice cache debug",
    `Latest review cache key: ${new URL("__typed_voice_source/latest-review.json", scopeUrl).href}`,
    `Latest review generation: ${generation || "不明"}`,
    `Review document build: ${/^\d+$/.test(String(manifest?.buildNumber || "")) ? `#${manifest.buildNumber}` : "不明"}`,
    "",
    "[Latest review source assets]",
  ];
  for (const [path, entry] of Object.entries(manifest?.assets || {})) {
    const originals = Array.isArray(entry?.originalFiles) && entry.originalFiles.length > 0
      ? entry.originalFiles.join(", ")
      : "不明";
    const build = /^\d+$/.test(String(entry?.buildNumber || "")) ? `#${entry.buildNumber}` : "不明";
    lines.push(`${path} <- ${originals} | build=${build} | group=${entry?.group || "不明"} | xxh3=${entry?.xxh3_128 || "不明"}`);
  }
  lines.push("", "[Cache Storage full keys]");
  for (const name of cacheNames) {
    const cache = await caches.open(name);
    const requests = await cache.keys();
    lines.push(`CACHE ${name} (${requests.length} keys)`);
    for (const request of requests) lines.push(`  ${request.method} ${request.url}`);
  }
  lines.push("", "[Service Worker requests]");
  for (const entry of requestLog) {
    lines.push(`${entry.time || "?"} ${entry.method || "?"} ${entry.status ?? "?"} route=${entry.route || "?"} mode=${entry.mode || "?"} destination=${entry.destination || "-"} ${entry.url || ""}${entry.reason ? ` | ${entry.reason}` : ""}`);
  }
  lines.push("", "[debug]");
  lines.push(...debugLogLines);
  output.value = lines.join("\n");
}

function initializeRuntimeDebugUi() {
  const details = document.getElementById("runtime-debug");
  const output = document.getElementById("runtime-debug-output");
  const copy = document.getElementById("runtime-debug-copy");
  if (!details || !output || !copy) return;
  const refresh = async () => {
    output.value = "取得中…";
    try {
      await renderRuntimeDebug(output);
    } catch (error) {
      output.value = `デバッグ情報の取得に失敗しました。\n${error instanceof Error ? error.message : String(error)}`;
    }
  };
  details.addEventListener("toggle", () => {
    if (details.open) void refresh();
  });
  copy.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(output.value);
      copy.textContent = "コピーしました";
      globalThis.setTimeout(() => { copy.textContent = "コピー"; }, 1200);
    } catch {
      output.focus();
      output.select();
      document.execCommand?.("copy");
    }
  });
}

const blocking = createBlockingTaskOrchestrator(document);
initializeRuntimeDebugUi();
const remoteModeUi = await blocking.registerBlockingAsync("接続モード", async ({ report }) => {
  report({ detail: "クライアントモードの保存状態を確認しています。" });
  return initializeRemoteModeUi(document);
});
const sourceAssetGroups = remoteModeUi.isServerMode ? ["core", "client"] : ["core", "engine"];
const serviceWorkerState = await blocking.registerBlockingAsync("Service Worker", async ({ report }) => {
  report({ detail: "オフライン実行の準備を確認しています。" });
  return requireServiceWorker({ reloadKey: "typed-voice-app-coi-reloaded" });
});
const sourceIntegrityState = await blocking.registerBlockingAsync("ソース検証", async ({ report }) => {
  if (serviceWorkerState?.repairRequired) {
    report({ detail: "Service Workerの自己ハッシュが審査書類と一致しないため、更新修復が必要です。" });
    return { corruptCount: 0, corruptBytes: 0, missingCount: 0, missingBytes: 0 };
  }
  report({ detail: "保存済みのアプリファイルをXXH3-128で検証しています。" });
  return verifyStoredSourceAssets(sourceAssetGroups, {
    onProgress(progress) {
      const checkedBytes = Math.max(0, Number(progress.checkedBytes || 0));
      const totalBytes = Math.max(0, Number(progress.totalBytes || 0));
      report({
        detail: progress.path ? `保存済みファイルを検証しています: ${progress.path}` : "保存済みファイルを検証しています。",
        ...(totalBytes > 0 ? {
          primary: {
            label: "ソース検証",
            value: checkedBytes,
            total: totalBytes,
            text: `${(checkedBytes / 1024 / 1024).toFixed(1)} / ${(totalBytes / 1024 / 1024).toFixed(1)} MiB`,
          },
        } : {}),
      });
    },
  });
});
const tutorialState = await blocking.registerBlockingAsync("保存状態", async ({ report }) => {
  report({ detail: "チュートリアルと会話データの状態を確認しています。" });
  return reconcileTutorialPersistence();
});
const sourceUpdateState = await blocking.registerBlockingAsync("更新確認", async ({ report }) => {
  if (serviceWorkerState?.repairRequired) {
    report({ detail: "古いService Workerを登録解除して最新化する必要があります。保存済みキャッシュは保持されます。" });
    return {
      generation: readStoredSourceGeneration(),
      acceptedGeneration: readStoredSourceGeneration(),
      updateAvailable: true,
      totalBytes: 0,
      fetchBytes: 0,
      reusableBytes: 0,
      assetCount: 0,
      fetchCount: 0,
      repairRequired: true,
      serviceWorkerRepairRequired: true,
      sourceAssetMapNetworkAvailable: true,
    };
  }
  report({
    detail: Number(sourceIntegrityState?.corruptCount || 0) > 0
      ? "破損した保存済みファイルを削除しました。再取得が必要なファイルを判定しています。"
      : "配布されたハッシュ一覧を確認し、再利用できるソースと取得が必要なソースを判定しています。",
  });
  return planSourceAssets(sourceAssetGroups);
});
const sourceAssetsPending = Boolean(sourceUpdateState.updateAvailable)
  || Number(sourceUpdateState.fetchBytes || 0) > 0;
const sourceUpdate = {
  plan: { ...sourceUpdateState },
  async prepare({ signal = null, onProgress = () => {} } = {}) {
    closeOtherTabsForSourceUpdate();
    if (this.plan.serviceWorkerRepairRequired) {
      await unregisterTypedVoiceServiceWorker();
      return { generation: this.plan.generation, serviceWorkerRepairRequired: true };
    }
    const result = await applySourceAssets(sourceAssetGroups, { signal, onProgress });
    this.plan = {
      ...this.plan,
      generation: result.generation,
      acceptedGeneration: result.generation,
      updateAvailable: false,
      fetchBytes: 0,
      reusableBytes: Number(this.plan.totalBytes || 0),
      fetchCount: 0,
    };
    return result;
  },
};
const voiceStatus = document.querySelector("#voice-status");
const manifestUrl = new URL(`${import.meta.env.BASE_URL}voice-manifest.json`, document.baseURI).href;
const appBaseUrl = new URL(import.meta.env.BASE_URL, document.baseURI).href;
let voiceRuntime;
let remoteWorkerBlockingPromise = null;

function ensureRemoteWorkerBlocking(status) {
  if (!remoteModeUi.isServerMode || Number(status?.ready || 0) > 0 || remoteWorkerBlockingPromise || !voiceRuntime?.waitForWorkerReady) return;
  remoteWorkerBlockingPromise = blocking.registerBlockingAsync("音声モデル", async ({ report }) => {
    const reportStatus = (workerStatus) => {
      const connected = Math.max(0, Number(workerStatus?.connected || 0));
      const ready = Math.max(0, Number(workerStatus?.ready || 0));
      report({
        detail: connected > 0
          ? "サーバー側の音声モデルを読み込んでいます。準備済みWorkerができるまで待機します。"
          : "音声合成Workerの接続を待っています。クライアントから個別の再試行は行いません。",
        primary: {
          label: "Trusted Worker",
          value: ready,
          total: Math.max(1, connected),
          text: `${ready} / ${connected} 準備済み`,
        },
      });
    };
    await voiceRuntime.waitForWorkerReady({ onStatus: reportStatus });
  }).catch(() => {}).finally(() => {
    remoteWorkerBlockingPromise = null;
    blocking.finish();
  });
}

if (remoteModeUi.isServerMode && remoteModeUi.pairing) {
  const { RemoteVoiceRuntime } = await import("./app/remote-voice-runtime.js");
  voiceRuntime = new RemoteVoiceRuntime(remoteModeUi.pairing, {
    audioFormat: remoteModeUi.audioFormat,
    onOpen() {
      remoteModeUi.showTransportConnected();
    },
    onAuthenticated() {
      remoteModeUi.showHandshakeSuccess();
    },
    onServerConfig(config) {
      remoteModeUi.applyServerConfig(config);
    },
    onWorkerStatus(status) {
      ensureRemoteWorkerBlocking(status);
    },
    onFailure(error) {
      if (sourceUpdateState.updateAvailable) return;
      remoteModeUi.showHandshakeFailure(error instanceof Error ? error.message : String(error));
    },
    onClose() {
      if (sourceUpdateState.updateAvailable) return;
      remoteModeUi.showHandshakeFailure("以前の接続が切断されました。パソコン側に表示された新しいQRを読み取ってください。");
    },
  });
} else if (remoteModeUi.isServerMode) {
  voiceRuntime = new NoVoiceRuntime();
} else {
  const { VoiceRuntimeAdapter } = await import("./app/voice-runtime-adapter.js");
  voiceRuntime = new VoiceRuntimeAdapter({
    manifestUrl,
    appBaseUrl,
    onStatus(message) {
      voiceStatus.textContent = message;
    },
  });
  globalThis.addEventListener("pagehide", (event) => {
    if (!event.persisted) voiceRuntime.client?.abort();
  }, { once: true });
}
const modelProfileUi = await blocking.registerBlockingAsync("画面設定", async ({ report }) => {
  report({ detail: "保存済みの音声設定を読み込んでいます。" });
  return initializeModelProfileUi(document);
});
remoteModeUi.attachModelProfileUi(modelProfileUi);
remoteModeUi.attachVoiceRuntime(voiceRuntime);
const app = new UiOrchestrator(document, {
  voiceRuntime,
  getModelProfile: () => modelProfileUi.profile,
});
await blocking.registerBlockingAsync("会話データ", async ({ report }) => {
  report({ detail: "会話データベースを開いています。" });
  await app.initialize();
});
const selectedModelCached = remoteModeUi.isServerMode
  ? false
  : await blocking.registerBlockingAsync("音声キャッシュ", async ({ report }) => {
      report({ detail: "選択中の音声モデルがこの端末に保存済みかService Workerへ確認しています。" });
      return app.isVoiceProfileCached(modelProfileUi.profile);
    });
await blocking.registerBlockingAsync("操作画面", async ({ report }) => {
  report({ detail: "バックアップとチュートリアルを準備しています。" });
  initializeBackupUi(document, {
    app,
    modelProfileUi,
    restartOverride: remoteModeUi.isServerMode ? () => remoteModeUi.reconnectServer() : null,
  });
  const offlineRuntimeResetUi = initializeOfflineRuntimeResetUi(document, {
    db: app.repository?.db,
    app,
    modelProfileUi,
  });
  globalThis.typedVoiceDebug = Object.assign(globalThis.typedVoiceDebug ?? {}, {
    showOfflineResetFreeze: () => offlineRuntimeResetUi.showFreeze(),
  });
  const tutorial = new TutorialController(document, {
    modelProfileUi,
    app,
    tutorialComplete: tutorialState.complete,
    sourceUpdate,
  }).initialize();
  const restartTutorialButton = document.getElementById("restart-tutorial");

  const endTutorialProfile = Object.freeze({
    terminal: true,
  });

  const sourceUpdateProfile = Object.freeze({
    route: Object.freeze([
      Object.freeze({ step: "source-update", id: "source-update", nextLabel: "次へ" }),
    ]),
    headerBrand: "typed-voice の更新",
    completionLabel: "次へ",
    completeTo: remoteModeUi.isServerMode
      ? "end"
      : selectedModelCached
        ? "end"
        : "model-picker-required",
    closeOnBackAtStart: false,
  });

  const fullTutorialProfile = Object.freeze({
    route: FULL_TUTORIAL_ROUTE,
    headerBrand: "はじめての typed-voice",
    completionLabel: "使い始める",
    completeTo: "end",
    lockBackDuringModelLoad: true,
    onOpen({ controller, modelProfileUi: profileUi }) {
      restartTutorialButton.disabled = true;
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
      restartTutorialButton.disabled = false;
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

  const serverModeProfile = Object.freeze({
    route: Object.freeze([
      Object.freeze({ step: "server-mode-about", id: "server-mode-about", nextLabel: "次へ" }),
      Object.freeze({ step: "tsukuyomichan", id: "tsukuyomichan", nextLabel: "次へ" }),
      Object.freeze({ step: "server-mode-trust", id: "server-mode-trust", nextLabel: "次へ" }),
      Object.freeze({ step: "server-mode-volunteer-privacy", id: "server-mode-volunteer-privacy", nextLabel: "次へ" }),
      Object.freeze({ step: "server-mode-volunteer-audio", id: "server-mode-volunteer-audio", nextLabel: "パソコン側の準備を見る" }),
      Object.freeze({ step: "server-mode-setup", id: "server-mode-setup", nextLabel: "QRの読み取りへ" }),
      Object.freeze({ step: "server-mode-pairing", id: "server-mode-pairing", nextLabel: "QRを読み取る" }),
    ]),
    headerBrand: "クライアントモード",
    completionLabel: "QRを読み取る",
    completeTo: "end",
    cancelTo: "end",
    closeOnBackAtStart: true,
    onCancel() {
      remoteModeUi.cancelServerTutorial();
    },
    onComplete() {
      remoteModeUi.openPairingPage();
    },
  });

  const serverOfflineProfile = Object.freeze({
    route: Object.freeze([
      Object.freeze({ step: "server-mode-offline", id: "server-mode-offline", nextLabel: "とにかく進みたい" }),
    ]),
    headerBrand: "クライアントモード",
    completionLabel: "とにかく進みたい",
    completeTo: "server-mode",
    closeOnBackAtStart: false,
  });

  const serverReconnectProfile = Object.freeze({
    route: Object.freeze([
      Object.freeze({ step: "server-mode-reconnect", id: "server-mode-reconnect", nextLabel: "次へ" }),
      Object.freeze({ step: "server-mode-reconnect-trust", id: "server-mode-reconnect-trust", nextLabel: "次へ" }),
      Object.freeze({ step: "server-mode-volunteer-privacy", id: "server-mode-volunteer-privacy", nextLabel: "次へ" }),
      Object.freeze({ step: "server-mode-volunteer-audio", id: "server-mode-volunteer-audio", nextLabel: "次へ" }),
      Object.freeze({ step: "server-mode-reconnect-qr", id: "server-mode-reconnect-qr", nextLabel: "QRを読み取る" }),
    ]),
    headerBrand: "クライアントモード",
    completionLabel: "OK、QRを読み取る",
    completeTo: "end",
    cancelTo: "end",
    closeOnBackAtStart: true,
    onCancel() {
      remoteModeUi.cancelServerTutorial();
    },
    onComplete() {
      remoteModeUi.openPairingPage();
    },
  });

  tutorial
    .registerProfile("end", endTutorialProfile)
    .registerProfile("source-update", sourceUpdateProfile)
    .registerProfile("full", fullTutorialProfile)
    .registerProfile("model-picker", modelPickerProfile)
    .registerProfile("model-picker-required", requiredModelPickerProfile)
    .registerProfile("server-offline", serverOfflineProfile)
    .registerProfile("server-mode", serverModeProfile)
    .registerProfile("server-reconnect", serverReconnectProfile);

  const shouldShowServerOfflineTutorial = () => (
    remoteModeUi.isServerMode && sourceUpdateState.sourceAssetMapNetworkAvailable === false
  );
  const openServerModeTutorial = () => tutorial.openProfile(
    shouldShowServerOfflineTutorial() ? "server-offline" : "server-mode"
  );

  document.getElementById("tutorial-server-offline-reload")?.addEventListener("click", () => {
    document.location.reload();
  });

  document.getElementById("remote-reconnect-help")?.addEventListener("click", () => {
    void openServerModeTutorial();
  });

  if (remoteModeUi.isServerMode) {
    const serverStartupProfile = sourceAssetsPending
      ? "source-update"
      : remoteModeUi.shouldRunServerTutorialAtStartup()
        ? shouldShowServerOfflineTutorial()
          ? "server-offline"
          : "server-mode"
        : "end";
    await tutorial.openProfile(serverStartupProfile);
  } else {
    await tutorial.openProfile(resolveStartupTutorialProfile({
      tutorialComplete: tutorialState.complete,
      selectedModelCached,
      sourceUpdateAvailable: sourceUpdateState.updateAvailable,
      sourceFetchBytes: sourceUpdateState.fetchBytes,
    }));
  }

  remoteModeUi.bindActions({
    openTutorial: openServerModeTutorial,
    openReconnectTutorial: () => tutorial.openProfile("server-reconnect"),
    onHandshakeSuccess: () => {
      if (["server-mode", "server-reconnect"].includes(tutorial.activeProfile?.name)) {
        void tutorial.openProfile("end");
      }
    },
  });
  await remoteModeUi.activateStoredConnection();
  if (remoteModeUi.isServerMode
    && !sourceAssetsPending
    && remoteModeUi.startupAction === "handshake"
    && remoteModeUi.pairing) {
    voiceRuntime.connect();
    globalThis.addEventListener("pagehide", () => voiceRuntime.close?.(), { once: true });
  }
  if (remoteModeUi.isServerMode) {
    voiceStatus.textContent = "クライアントモードでは、この端末の音声モデルを読み込みません。";
  }

  document.getElementById("settings-model-picker")?.addEventListener("click", () => {
    modelProfileUi.closeSettings();
    void tutorial.openProfile("model-picker");
  });
});
blocking.finish();
if (!remoteModeUi.isServerMode
  && tutorialState.complete
  && selectedModelCached
  && !sourceAssetsPending) {
  void app.initializePreparedVoice(modelProfileUi.profile, { enableAudio: false }).catch(() => {});
}


