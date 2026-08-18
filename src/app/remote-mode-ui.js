import {
  buildLocalModeUrl,
  buildServerModeUrl,
  isServerModeUrl,
  resolveRemoteStartupAction,
} from "./remote-mode-policy.js";
import {
  readRemotePairing,
} from "./remote-pairing-store.js";

export class RemoteModeUi {
  constructor(documentRef, { pairing }) {
    this.document = documentRef;
    this.pairing = pairing ?? null;
    this.isServerMode = isServerModeUrl(this.document.location?.href ?? globalThis.location?.href ?? "https://typed-voice.invalid/");
    this.startupAction = resolveRemoteStartupAction({
      serverMode: this.isServerMode,
      hasPairing: Boolean(this.pairing),
    });
    this.settingsButton = this.document.getElementById("settings-server-connect");
    this.banner = this.document.getElementById("remote-mode-banner");
    this.statusTitle = this.document.getElementById("remote-mode-status-title");
    this.statusDetail = this.document.getElementById("remote-mode-status-detail");
    this.rescanButton = this.document.getElementById("remote-mode-rescan");
    this.localButton = this.document.getElementById("remote-mode-client");
    this.headerLaunchButton = this.document.getElementById("client-mode-launch");
    this.modelPickerButton = this.document.getElementById("settings-model-picker");
    this.connectionBlocker = this.document.getElementById("remote-connection-blocker");
    this.connectionTitle = this.document.getElementById("remote-connection-title");
    this.connectionState = this.document.getElementById("remote-connection-state");
    this.connectionEndpoint = this.document.getElementById("remote-connection-endpoint");
    this.connectionDetail = this.document.getElementById("remote-connection-detail");
    this.connectionRescanButton = this.document.getElementById("remote-connection-rescan");
    this.connectionLocalButton = this.document.getElementById("remote-connection-local");
    this.tutorialCloseLinks = [...(this.document.querySelectorAll?.(".server-mode-local-link") ?? [])];
    this.topbar = this.document.querySelector(".topbar");
    this.settingsPanel = this.document.getElementById("settings-panel");
    this.main = this.document.querySelector("main");
    this.openReconnectTutorial = null;
    this.connected = false;
    this.transportConnected = false;
    this.connectionStartedAt = 0;
    this.connectionTimer = 0;
    if (this.isServerMode) this.lockLocalControls();
  }

  shouldRunServerTutorialAtStartup() {
    return this.startupAction === "tutorial";
  }

  bindActions({ openTutorial, openReconnectTutorial }) {
    this.openReconnectTutorial = openReconnectTutorial ?? null;
    const localModeUrl = buildLocalModeUrl(this.document.location.href).href;
    for (const link of this.tutorialCloseLinks) link.href = localModeUrl;
    if (this.headerLaunchButton) {
      this.headerLaunchButton.hidden = this.isServerMode;
      this.headerLaunchButton.addEventListener("click", () => this.startClientMode());
    }
    this.settingsButton?.addEventListener("click", () => {
      if (!this.isServerMode) {
        this.startClientMode();
        return;
      }
      void openTutorial();
    });
    this.rescanButton?.addEventListener("click", () => this.openPairingPage());
    this.localButton?.addEventListener("click", () => this.restartInLocalMode());
    this.connectionRescanButton?.addEventListener("click", () => this.openPairingPage());
    this.connectionLocalButton?.addEventListener("click", () => this.restartInLocalMode());
    if (this.settingsButton && this.isServerMode) {
      this.settingsButton.firstChild.textContent = "クライアントモードの説明を見る";
      const description = this.settingsButton.querySelector("span");
      if (description) description.textContent = "接続方法と必要なものを、全画面の説明でもう一度確認します。";
    }
    if (this.modelPickerButton && this.isServerMode) this.modelPickerButton.hidden = true;
  }

  lockLocalControls() {
    if (!this.isServerMode) return;
    this.connected = false;
    this.transportConnected = false;
    for (const element of [this.topbar, this.settingsPanel, this.main]) {
      if (element) element.inert = true;
    }
    this.document.body.classList.add("remote-mode-locked");
  }

  startConnectionDisplay() {
    if (!this.isServerMode || !this.pairing) return;
    this.lockLocalControls();
    this.connectionStartedAt = Date.now();
    if (this.connectionEndpoint) this.connectionEndpoint.textContent = this.pairing.endpoint;
    if (this.connectionTitle) this.connectionTitle.textContent = "音声合成サーバーへ接続しています";
    if (this.connectionDetail) this.connectionDetail.textContent = "接続と認証が完了するまで、通常の操作は利用できません。";
    if (this.connectionBlocker) this.connectionBlocker.hidden = false;
    this.updateConnectionElapsed("未接続");
    this.stopConnectionTimer();
    this.connectionTimer = globalThis.setInterval(() => {
      const label = this.connected ? "接続済み" : (this.transportConnected ? "認証待ち" : "未接続");
      this.updateConnectionElapsed(label);
    }, 1000);
  }

  updateConnectionElapsed(label) {
    if (!this.connectionState || !this.connectionStartedAt) return;
    const elapsedSeconds = Math.max(0, Math.floor((Date.now() - this.connectionStartedAt) / 1000));
    this.connectionState.textContent = `${label} - ${elapsedSeconds}秒経過`;
  }

  stopConnectionTimer() {
    if (!this.connectionTimer) return;
    globalThis.clearInterval(this.connectionTimer);
    this.connectionTimer = 0;
  }

  showTransportConnected() {
    if (!this.isServerMode) return;
    this.transportConnected = true;
    if (this.connectionTitle) this.connectionTitle.textContent = "WSSへ接続しました。認証しています";
    if (this.connectionDetail) this.connectionDetail.textContent = "認証が完了するまで、通常の操作は利用できません。";
    this.updateConnectionElapsed("認証待ち");
  }

  unlockLocalControls() {
    if (!this.isServerMode) return;
    this.connected = true;
    this.transportConnected = true;
    for (const element of [this.topbar, this.settingsPanel, this.main]) {
      if (element) element.inert = false;
    }
    this.document.body.classList.remove("remote-mode-locked");
    this.stopConnectionTimer();
    if (this.connectionBlocker) this.connectionBlocker.hidden = true;
  }

  startClientMode() {
    const url = buildServerModeUrl(this.document.location.href);
    this.document.location.assign(url.href);
  }

  cancelServerTutorial() {
    this.restartInLocalMode();
  }

  openPairingPage({ replace = false } = {}) {
    const target = new URL("pairing.html", this.document.baseURI);
    target.searchParams.set("server", "1");
    const current = new URL(this.document.location.href);
    const conversation = current.searchParams.get("conversation");
    if (conversation) target.searchParams.set("conversation", conversation);
    const navigate = replace ? this.document.location.replace.bind(this.document.location) : this.document.location.assign.bind(this.document.location);
    navigate(target.href);
  }

  restartInLocalMode() {
    const url = buildLocalModeUrl(this.document.location.href);
    this.document.location.assign(url.href);
  }

  async activateStoredConnection() {
    if (!this.isServerMode) return;
    this.lockLocalControls();
    this.banner.hidden = false;
    if (!this.pairing) {
      this.statusTitle.textContent = "接続情報がありません";
      this.statusDetail.textContent = "接続するまで、この画面の通常操作は利用できません。新しいQRを読み取ってください。";
      return;
    }
    const endpoint = new URL(this.pairing.endpoint);
    this.statusTitle.textContent = `${endpoint.hostname} へ接続しています`;
    this.statusDetail.textContent = "ハンドシェイクが完了するまで、この画面の通常操作は利用できません。";
    this.startConnectionDisplay();
  }

  showHandshakeSuccess() {
    if (!this.isServerMode || !this.pairing) return;
    const endpoint = new URL(this.pairing.endpoint);
    this.statusTitle.textContent = `${endpoint.hostname} へ接続しました`;
    this.statusDetail.textContent = "音声合成サーバーを利用できます。";
    this.unlockLocalControls();
  }

  showHandshakeFailure(message = "接続できませんでした。新しいQRを読み取って、もう一度接続してください。") {
    if (!this.isServerMode) return;
    this.lockLocalControls();
    this.transportConnected = false;
    this.banner.hidden = false;
    this.statusTitle.textContent = "音声合成サーバーへ接続できませんでした";
    this.statusDetail.textContent = message;
    this.stopConnectionTimer();
    if (this.connectionBlocker) this.connectionBlocker.hidden = true;
    void this.openReconnectTutorial?.();
  }
}

export async function initializeRemoteModeUi(documentRef = document) {
  const pairing = await readRemotePairing().catch(() => null);
  return new RemoteModeUi(documentRef, { pairing });
}
