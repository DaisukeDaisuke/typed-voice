import { MODEL_PROFILES } from "./model-profile-ui.js";

const TUTORIAL_STORAGE_KEY = "typed-voice-tutorial-v1-complete";
const SAMPLE_URLS = Object.freeze({
  fp32: "https://huggingface.co/RabbitDaisuke/tsukuyomichan-omnivoice-full-finetune-onnx/resolve/main/samples/03_found_me_waiting.wav",
  fp16: "https://huggingface.co/RabbitDaisuke/tsukuyomichan-omnivoice-full-finetune-onnx/resolve/fp16/samples/03_found_me_waiting.wav",
  "mobile-int8": "https://huggingface.co/RabbitDaisuke/tsukuyomichan-omnivoice-full-finetune-onnx/resolve/mobile-int8/samples/03_found_me_waiting.wav",
  "mobile-int4": "https://huggingface.co/RabbitDaisuke/tsukuyomichan-omnivoice-full-finetune-onnx/resolve/mobile-int4/samples/03_found_me_waiting.wav",
});
const DEMO_TEXTS = Object.freeze([
  "こんにちは。今日は何を読み上げましょうか？",
  "お待たせしました。準備ができました。",
  "ちょっと休憩してから、続きを始めましょう。",
  "この文章は、読み上げの練習用です。",
  "うまく届いたら、そのまま次へ進めます。",
  "WebAssemblyの準備ができました。",
  "読み上げたい文章を、ここに書いてみましょう。",
  "あとから訂正できるので、気軽に入力してください。",
  "やっぱり違うと思ったら、取り消すこともできます。",
  "それでは、ひとつ読み上げてみますね。",
]);
const CORRECTION_TEXTS = Object.freeze([
  "こんにちは。今日はゆっくり読み上げてください。",
  "お待たせしました。準備はもうできています。",
  "少し休憩してから、続きを始めてください。",
  "この文章は、読み上げ確認のための例文です。",
  "うまく届いたので、そのまま次へ進みましょう。",
  "WebAssemblyの準備ができたので、試してみます。",
  "読み上げたい文章を、ここへ入力してみてください。",
  "あとから直せるので、気軽に書いて大丈夫です。",
  "やっぱり違うと思ったら、あとから取り消せます。",
  "それでは、もう一度読み上げてみますね。",
  "この一文だけ、少し短く言い直してみます。",
  "声の速度を変えて、もう一度確認してみましょう。",
  "次の文章は、訂正の動きを試すためのサンプルです。",
  "入力した内容を残したまま、最後の一文だけ直します。",
  "読み上げる直前なら、文章を差し替えられます。",
  "この部分だけ表現を変えて、自然な文章にします。",
  "さっきの文章を少しだけ分かりやすく直します。",
  "最後の言い回しだけ変えて、もう一度試します。",
  "訂正ボタンを使うと、送り直さずに変更できます。",
  "例文なので、ここでは通常の訂正制限を気にせず試せます。",
]);
const CANCEL_DEMO_TEXT = "やっぱり違うと思ったら、取り消すこともできます。";
const WAIT_DEMO_TEXT = "この文章は、読み上げ待ち時間を確認するための例です。";

function safeRead(storage, key) {
  try {
    return storage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function safeWrite(storage, key, value) {
  try {
    storage?.setItem(key, value);
  } catch {
    // The tutorial still works for the current page when localStorage is blocked.
  }
}

function safeRemove(storage, key) {
  try {
    storage?.removeItem(key);
  } catch {
    // No cache or IndexedDB operation is intentionally performed here.
  }
}

export class TutorialController {
  constructor(documentRef = document, { modelProfileUi = null, app = null, storage = globalThis.localStorage } = {}) {
    this.document = documentRef;
    this.modelProfileUi = modelProfileUi;
    this.app = app;
    this.storage = storage;
    this.stepIndex = 0;
    this.demoSnapshot = null;
    this.demoRunToken = 0;
    this.demoRunning = false;
    this.lastDemoText = null;
    this.lastCorrectionText = null;
    this.demoHistoryTexts = [];
    this.cancelExamplePreparing = false;
    this.waitDemoPending = null;
    this.waitPendingCountSnapshot = null;
    this.downloadAcknowledged = false;
    const voiceState = this.app?.voiceRuntimeState;
    this.downloadCompleted = Boolean(
      voiceState?.prepared
      && voiceState.profile === (this.modelProfileUi?.profile ?? "fp16")
    );
    this.downloadRunning = false;
    this.downloadAbortController = null;
    this.downloadTask = null;
    this.sampleAudioContext = null;
    this.sampleSource = null;
    this.sampleAssetBytes = new Map();
    this.sampleAssetPromises = new Map();
    this.sampleBuffers = new Map();
    this.downloadProgressUnsubscribe = null;
    this.downloadProgressLast = null;
    this.targetArrowTarget = null;
    this.summaryReturnIndex = null;
    this.conversationTutorialCompleted = false;
    this.elements = this.#resolveElements();
  }

  initialize() {
    this.elements.overlay.addEventListener("pointerdown", () => this.#acknowledgeStep());
    this.elements.overlay.addEventListener("keydown", () => this.#acknowledgeStep());
    this.document.addEventListener("click", (event) => this.#guardTutorialNavigation(event), true);
    globalThis.addEventListener?.("resize", () => this.#refreshTargetArrow(), { passive: true });
    this.document.addEventListener("scroll", () => this.#refreshTargetArrow(), { capture: true, passive: true });
    this.elements.back.addEventListener("click", () => this.previous());
    this.elements.next.addEventListener("click", () => this.next());
    this.elements.restart.addEventListener("click", async () => {
      safeRemove(this.storage, TUTORIAL_STORAGE_KEY);
      this.modelProfileUi?.closeSettings();
      await this.app?.endTutorialExamples?.();
      this.start();
    });
    this.elements.linebreakDemo.addEventListener("click", () => void this.#runLinebreakDemo());
    this.elements.correctionDemo.addEventListener("click", () => void this.#runCorrectionDemo());
    this.elements.cancelDemo.addEventListener("click", () => void this.#runCancelDemo());
    this.elements.sampleButton.addEventListener("click", () => void this.#runSamplePreview());
    this.elements.downloadAck.addEventListener("click", () => this.#acknowledgeDownload());
    this.elements.downloadButton.addEventListener("click", () => void this.#runVoiceDownload());
    this.elements.waitSeconds.addEventListener("change", () => void this.#applyWaitSetting());
    this.elements.waitDemo.addEventListener("click", () => void this.#runWaitDemo());
    this.elements.conversationView.addEventListener("click", () => {
      globalThis.setTimeout(() => this.#handleConversationListOpened(), 0);
    });
    this.elements.conversationList.addEventListener("click", (event) => {
      if (!event.target.closest('[data-tutorial-conversation="true"]')) return;
      globalThis.setTimeout(() => void this.#handleTutorialConversationOpened(), 0);
    });
    for (const button of this.elements.summaryJumpButtons) {
      button.addEventListener("click", () => this.#jumpFromSummary(button.dataset.tutorialJump));
    }
    this.document.addEventListener("typed-voice:model-profile-ui-change", () => {
      this.#stopSample();
      const voiceState = this.app?.voiceRuntimeState;
      this.downloadCompleted = Boolean(
        voiceState?.prepared
        && voiceState.profile === (this.modelProfileUi?.profile ?? "fp16")
      );
      this.#resetDownloadAcknowledgement();
      this.#renderDownloadDisclosure();
      this.#resetDownloadProgress();
      if (this.elements.overlay.dataset.step === "download") this.#showStep();
    });

    if (safeRead(this.storage, TUTORIAL_STORAGE_KEY) !== "1") {
      this.start();
    } else {
      void this.app?.initializePreparedVoice?.(this.modelProfileUi?.profile ?? "fp16", { enableAudio: false }).catch(() => {});
    }
    return this;
  }

  start() {
    this.#cleanupDemo();
    this.app?.beginTutorialExamples?.();
    const voiceState = this.app?.voiceRuntimeState;
    this.downloadCompleted = Boolean(
      voiceState?.prepared
      && voiceState.profile === (this.modelProfileUi?.profile ?? "fp16")
    );
    this.#resetDownloadAcknowledgement();
    this.#renderDownloadDisclosure();
    this.#resetDownloadProgress();
    this.summaryReturnIndex = null;
    this.conversationTutorialCompleted = false;
    this.stepIndex = 0;
    this.elements.overlay.hidden = false;
    this.document.body.classList.add("tutorial-open");
    this.#showStep();
  }

  previous() {
    this.#scrollPageToTop();
    if (this.summaryReturnIndex != null && this.stepIndex !== this.summaryReturnIndex) {
      this.#returnToSummary();
      return;
    }
    if (this.stepIndex === 0) return;
    this.stepIndex -= 1;
    this.#showStep();
  }

  next() {
    if (this.summaryReturnIndex != null && this.stepIndex !== this.summaryReturnIndex) {
      this.#scrollPageToTop();
      this.#returnToSummary();
      return;
    }
    if (this.stepIndex >= this.elements.pages.length - 1) {
      this.complete();
      return;
    }
    this.#scrollPageToTop();
    this.stepIndex += 1;
    this.#showStep();
  }

  complete() {
    const profile = this.modelProfileUi?.profile ?? "fp16";
    safeWrite(this.storage, TUTORIAL_STORAGE_KEY, "1");
    this.#cleanupDemo();
    void this.app?.endTutorialExamples?.();
    this.elements.overlay.hidden = true;
    this.document.body.classList.remove("tutorial-open", "tutorial-scrollable");
    this.#stopSample({ close: true });
    this.elements.composer.focus({ preventScroll: true });
    void this.app?.initializePreparedVoice?.(profile, { enableAudio: false }).catch(() => {});
  }

  #showStep() {
    if (this.summaryReturnIndex === this.stepIndex) this.summaryReturnIndex = null;
    const page = this.elements.pages[this.stepIndex];
    for (const [index, candidate] of this.elements.pages.entries()) {
      candidate.hidden = index !== this.stepIndex;
    }
    this.elements.overlay.classList.toggle("tutorial-live", page.dataset.tutorialLive === "true");
    this.elements.overlay.setAttribute("aria-modal", page.dataset.tutorialLive === "true" ? "false" : "true");
    this.elements.overlay.dataset.step = page.dataset.tutorialStep;
    this.document.body.classList.toggle("tutorial-scrollable", this.stepIndex >= 2);
    if (page.dataset.tutorialStep !== "conversations") {
      void this.app?.closeTutorialConversationDemo?.({ remove: true });
    }
    this.elements.progress.textContent = `${this.stepIndex + 1} / ${this.elements.pages.length}`;
    this.elements.overlay.classList.add("tutorial-needs-attention");
    this.elements.back.disabled = this.stepIndex === 0;
    this.elements.back.textContent = this.summaryReturnIndex != null && this.stepIndex !== this.summaryReturnIndex
      ? `${this.summaryReturnIndex + 1} / ${this.elements.pages.length}へ戻る`
      : "戻る";
    this.elements.next.textContent = this.summaryReturnIndex != null && this.stepIndex !== this.summaryReturnIndex
      ? `${this.summaryReturnIndex + 1} / ${this.elements.pages.length}へ戻る`
      : page.dataset.tutorialStep === "free"
        ? "次に、音声データをダウンロードしてみる"
        : this.stepIndex === this.elements.pages.length - 1 ? "使い始める" : "次へ";
    this.elements.next.disabled = (page.dataset.tutorialStep === "download" && !this.downloadCompleted)
      || (page.dataset.tutorialStep === "conversations" && !this.conversationTutorialCompleted);
    this.#updateHighlights(page.dataset.tutorialStep);
    if (page.dataset.tutorialStep === "wait") this.#syncWaitSetting();
    if (page.dataset.tutorialStep === "cancel") void this.#prepareCancelExample();
    if (page.dataset.tutorialStep === "conversations") void this.#prepareConversationTutorial();
    if (page.dataset.tutorialStep === "download" && !this.downloadCompleted) void this.#loadActualDownloadPlan();
    this.elements.pagesContainer.scrollTop = 0;
    if (page.dataset.tutorialStep === "download" && !this.downloadCompleted && !this.downloadAcknowledged) {
      this.elements.downloadAck.focus({ preventScroll: true });
    } else if (page.dataset.tutorialStep === "download" && !this.downloadCompleted) {
      this.elements.downloadButton.focus({ preventScroll: true });
    } else {
      this.elements.next.focus({ preventScroll: true });
    }
  }

  #acknowledgeStep() {
    this.elements.overlay.classList.remove("tutorial-needs-attention");
  }

  #scrollPageToTop() {
    const scrollingElement = this.document.scrollingElement ?? this.document.documentElement;
    scrollingElement.scrollTop = 0;
    this.document.body.scrollTop = 0;
  }

  #guardTutorialNavigation(event) {
    if (this.elements.overlay.hidden) return;
    const link = event.target.closest?.("a[href]");
    if (link && !this.elements.overlay.contains(link)) {
      event.preventDefault();
      event.stopImmediatePropagation();
      const status = this.elements.overlay.dataset.step === "free"
        ? this.elements.freeStatus
        : this.elements.conversationStatus;
      if (status) status.textContent = "外部ページはチュートリアルが終わってから開けます。";
      return;
    }
    const blockedAction = event.target.closest?.("#voice-enable, #force-speak-button, #new-conversation");
    if (blockedAction && !this.elements.overlay.contains(blockedAction)) {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (this.elements.freeStatus) {
        this.elements.freeStatus.textContent = blockedAction.id === "new-conversation"
          ? "新しい会話を作るのはチュートリアルが終わってから試せます。ここでは用意した一時会話で切り替えを試せます。"
          : "音声は次のページでデータを保存してから使えるようになります。";
      }
    }
  }

  async #prepareConversationTutorial() {
    await this.app?.beginTutorialConversationDemo?.();
    if (this.elements.overlay.dataset.step !== "conversations") return;
    this.elements.conversationStatus.textContent = this.conversationTutorialCompleted
      ? "切り替えできました。会話一覧から別の会話を選ぶと、履歴も一緒に切り替わります。"
      : "まずは上の「会話一覧」を押してみましょう。";
    this.#updateHighlights("conversations");
  }

  #handleConversationListOpened() {
    if (this.elements.overlay.dataset.step !== "conversations" || this.conversationTutorialCompleted) return;
    const row = this.elements.conversationList.querySelector('[data-tutorial-conversation="true"]');
    if (!row) return;
    this.elements.conversationStatus.textContent = "一覧が開きました。「チュートリアル用の会話」を押して、履歴を切り替えてみましょう。";
    this.#updateHighlights("conversations");
  }

  async #handleTutorialConversationOpened() {
    if (this.elements.overlay.dataset.step !== "conversations") return;
    await this.#waitFor(() => this.app?.isTutorialConversationOpen === true, this.demoRunToken, 2500);
    if (!this.app?.isTutorialConversationOpen) return;
    this.conversationTutorialCompleted = true;
    this.elements.next.disabled = false;
    this.elements.conversationStatus.textContent = "切り替わりました。上の「会話一覧」を使えば、会話ごとに履歴を行き来できます。";
    this.#updateHighlights("conversations");
  }

  #jumpFromSummary(stepName) {
    const summaryIndex = this.elements.pages.findIndex((page) => page.dataset.tutorialStep === "finish");
    const targetIndex = this.elements.pages.findIndex((page) => page.dataset.tutorialStep === stepName);
    if (summaryIndex < 0 || targetIndex < 0) return;
    this.summaryReturnIndex = summaryIndex;
    this.stepIndex = targetIndex;
    this.#showStep();
  }

  #returnToSummary() {
    if (this.summaryReturnIndex == null) return;
    const target = this.summaryReturnIndex;
    this.summaryReturnIndex = null;
    this.stepIndex = target;
    this.#showStep();
  }

  #syncWaitSetting() {
    const value = this.app?.getReasoningSeconds?.() ?? 2;
    this.elements.waitSeconds.value = String(value);
    this.elements.waitStatus.textContent = `いまは ${value} 秒待ちます。ここで変えると、本体の設定も同じ値になります。`;
  }

  async #applyWaitSetting() {
    const value = await this.app?.setReasoningSeconds?.(this.elements.waitSeconds.value);
    const normalized = Number.isFinite(Number(value)) ? Number(value) : 2;
    this.elements.waitSeconds.value = String(normalized);
    this.elements.waitStatus.textContent = normalized === 0
      ? "0秒にしました。Enterのあとすぐ読み上げる設定です。"
      : `${normalized} 秒にしました。この間なら訂正や取り消しが間に合います。`;
  }

  async #runWaitDemo() {
    if (this.demoRunning) return;
    this.demoRunning = true;
    const runToken = ++this.demoRunToken;
    this.elements.waitDemo.disabled = true;
    this.elements.back.disabled = true;
    this.elements.next.disabled = true;
    this.#rememberComposer();

    try {
      while ((this.app?.tutorialPendingCount ?? 0) > 0) {
        if (!await this.app?.cancelLatestTutorialPending?.()) break;
      }
      this.#renderDemoHistory();

      const composer = this.elements.composer;
      this.#moveCaretToEnd();
      if (composer.value && !composer.value.endsWith("\n")) {
        composer.setRangeText("\n", composer.selectionStart, composer.selectionEnd, "end");
      }
      this.elements.waitStatus.textContent = "待ち時間を見せるための文章を入力しています。";
      if (!await this.#typeText(WAIT_DEMO_TEXT, runToken)) return;
      if (runToken !== this.demoRunToken) return;
      composer.setRangeText("\n", composer.selectionStart, composer.selectionEnd, "end");

      const seconds = Math.max(0, Math.min(30, Number(this.app?.getReasoningSeconds?.() ?? 2)));
      const pending = this.#showWaitDemoPending(WAIT_DEMO_TEXT, seconds);
      pending.scrollIntoView({ behavior: "smooth", block: "center", inline: "nearest" });
      this.targetArrowTarget = pending;
      requestAnimationFrame(() => this.#refreshTargetArrow());
      this.elements.waitStatus.textContent = seconds === 0
        ? "0秒なので、読み上げ待ちはすぐ終わります。"
        : `${seconds} 秒の読み上げ待ちに入りました。左のカードを見てください。`;

      const startedAt = performance.now();
      const durationMs = seconds * 1000;
      do {
        if (runToken !== this.demoRunToken) return;
        const elapsed = performance.now() - startedAt;
        const remaining = Math.max(0, durationMs - elapsed) / 1000;
        pending.querySelector(".pending-timer").textContent = `${remaining.toFixed(1)}秒`;
        if (remaining <= 0) break;
        await this.#sleep(80);
      } while (true);

      if (runToken !== this.demoRunToken) return;
      await this.#sleep(180);
      this.#removeWaitDemoPending();
      this.#appendDemoHistory(WAIT_DEMO_TEXT);
      const newestHistory = this.elements.messageList.querySelector(".tutorial-demo-message");
      newestHistory?.scrollIntoView({ behavior: "smooth", block: "start", inline: "nearest" });
      this.#updateHighlights("wait");
      this.elements.waitStatus.textContent = "待ち時間が終わりました。文章は読み上げ履歴のいちばん上へ移ります。";
    } finally {
      if (runToken === this.demoRunToken) {
        this.demoRunning = false;
        this.elements.waitDemo.disabled = false;
        this.elements.back.disabled = this.stepIndex === 0;
        this.elements.next.disabled = false;
      }
    }
  }

  #showWaitDemoPending(text, seconds) {
    this.#removeWaitDemoPending();
    const node = this.elements.pendingTemplate.content.firstElementChild.cloneNode(true);
    node.classList.add("tutorial-wait-pending", "tutorial-target");
    node.querySelector(".pending-state").textContent = "読み上げ待ち";
    node.querySelector(".pending-timer").textContent = `${seconds.toFixed(1)}秒`;
    node.querySelector(".pending-text").textContent = text;
    const cancel = node.querySelector(".pending-cancel");
    cancel.disabled = true;
    cancel.textContent = "待機中";
    if (this.waitPendingCountSnapshot == null) {
      this.waitPendingCountSnapshot = this.elements.pendingCount.textContent;
      const count = Number.parseInt(this.waitPendingCountSnapshot, 10);
      this.elements.pendingCount.textContent = String((Number.isFinite(count) ? count : 0) + 1);
    }
    this.elements.pendingList.prepend(node);
    this.waitDemoPending = node;
    return node;
  }

  #removeWaitDemoPending() {
    if (this.waitDemoPending?.isConnected) this.waitDemoPending.remove();
    this.waitDemoPending = null;
    if (this.waitPendingCountSnapshot != null) {
      this.elements.pendingCount.textContent = this.waitPendingCountSnapshot;
      this.waitPendingCountSnapshot = null;
    }
  }

  #resetDownloadAcknowledgement() {
    this.downloadAcknowledged = false;
    this.elements.downloadAck.disabled = true;
    this.elements.downloadAck.textContent = "容量を確認しています…";
    this.elements.downloadButton.disabled = true;
  }

  #renderDownloadDisclosure() {
    this.elements.downloadSize.textContent = this.downloadCompleted ? "保存済み" : "確認中…";
  }

  #acknowledgeDownload() {
    if (this.elements.downloadAck.disabled || this.downloadCompleted) return;
    this.downloadAcknowledged = true;
    this.elements.downloadAck.disabled = true;
    this.elements.downloadAck.textContent = "容量を確認しました";
    this.elements.downloadButton.disabled = false;
    this.elements.overlay.classList.remove("tutorial-needs-attention");
    this.#updateHighlights("download");
    this.elements.downloadButton.focus({ preventScroll: true });
  }

  async #runSamplePreview() {
    const profileKey = this.modelProfileUi?.profile ?? "fp16";
    const profile = MODEL_PROFILES[profileKey] ?? MODEL_PROFILES.fp16;
    const url = SAMPLE_URLS[profileKey] ?? SAMPLE_URLS.fp16;
    this.#stopSample();
    this.elements.sampleButton.disabled = true;
    this.elements.sampleStatus.textContent = this.sampleAssetBytes.has(profileKey)
      ? `${profile.title} をメモリから再生します。`
      : `${profile.title} の試聴WAVを取得しています。`;

    try {
      const view = this.document.defaultView ?? globalThis;
      const AudioContextCtor = view.AudioContext ?? view.webkitAudioContext;
      if (!AudioContextCtor) throw new Error("このブラウザでは試聴を再生できません。");
      this.sampleAudioContext ??= new AudioContextCtor();
      await this.sampleAudioContext.resume();
      const bytes = await this.#getSampleAsset(profileKey, url);
      let buffer = this.sampleBuffers.get(profileKey);
      if (!buffer) {
        buffer = await this.sampleAudioContext.decodeAudioData(bytes.slice(0));
        this.sampleBuffers.set(profileKey, buffer);
      }
      const source = this.sampleAudioContext.createBufferSource();
      source.buffer = buffer;
      source.connect(this.sampleAudioContext.destination);
      this.sampleSource = source;
      this.elements.sampleStatus.textContent = `${profile.title} を再生中です（${this.#formatBytes(bytes.byteLength)}）。`;
      source.onended = () => {
        if (this.sampleSource === source) {
          this.sampleSource = null;
          this.elements.sampleStatus.textContent = `${profile.title} の試聴が終わりました。何度でも再生できます。`;
        }
      };
      source.start();
    } catch (error) {
      this.elements.sampleStatus.textContent = error instanceof Error ? error.message : String(error);
    } finally {
      this.elements.sampleButton.disabled = false;
    }
  }

  #stopSample({ close = false } = {}) {
    if (this.sampleSource) {
      try {
        this.sampleSource.stop();
      } catch {
        // It may already have finished naturally.
      }
      this.sampleSource = null;
    }
    if (close && this.sampleAudioContext) {
      void this.sampleAudioContext.close();
      this.sampleAudioContext = null;
      this.sampleBuffers.clear();
    }
  }

  async #getSampleAsset(profileKey, url) {
    const cached = this.sampleAssetBytes.get(profileKey);
    if (cached) return cached;
    const existing = this.sampleAssetPromises.get(profileKey);
    if (existing) return existing;
    const request = (async () => {
      const response = await fetch(url, { cache: "force-cache" });
      if (!response.ok) throw new Error(`試聴WAVの取得に失敗しました (${response.status})`);
      const bytes = await response.arrayBuffer();
      this.sampleAssetBytes.set(profileKey, bytes);
      return bytes;
    })();
    this.sampleAssetPromises.set(profileKey, request);
    try {
      return await request;
    } finally {
      this.sampleAssetPromises.delete(profileKey);
    }
  }

  #resetDownloadProgress() {
    this.downloadProgressLast = null;
    this.downloadProgressUnsubscribe?.();
    this.downloadProgressUnsubscribe = null;
    this.elements.downloadProgress.value = this.downloadCompleted ? 100 : 0;
    this.elements.downloadPercent.textContent = this.downloadCompleted ? "100%" : "0%";
    this.elements.downloadBytes.textContent = this.downloadCompleted ? "準備済み" : "開始前";
    this.elements.downloadSpeed.textContent = this.downloadCompleted ? "キャッシュ済み" : "-- MB/s";
    this.elements.downloadStatus.textContent = this.downloadCompleted
      ? "音声データはすでに利用できます。"
      : "実際の容量を確認してから、ダウンロードを開始できます。";
    this.elements.downloadButton.disabled = this.downloadCompleted || !this.downloadAcknowledged;
    this.elements.downloadButton.textContent = this.downloadCompleted ? "音声データは準備済み" : "音声データをダウンロード";
  }

  async #loadActualDownloadPlan() {
    if (!this.app?.getVoiceProfilePlan || this.downloadRunning || this.downloadCompleted) return;
    try {
      const profile = this.modelProfileUi?.profile ?? "fp16";
      const plan = await this.app.getVoiceProfilePlan(profile);
      const totalBytes = Number(plan?.totalBytes || 0);
      if (totalBytes > 0 && !this.downloadRunning && !this.downloadCompleted) {
        const formatted = this.#formatBytes(totalBytes);
        this.elements.downloadSize.textContent = formatted;
        this.elements.downloadBytes.textContent = `予定 ${formatted}`;
        this.elements.downloadAck.disabled = false;
        this.elements.downloadAck.textContent = `この ${formatted} を保存する。了解した`;
        this.elements.downloadStatus.textContent = `実際に保存する容量は ${formatted} です。確認するまでダウンロードは始まりません。`;
        this.#updateHighlights("download");
      }
    } catch {
      if (!this.downloadRunning && !this.downloadCompleted) {
        this.elements.downloadSize.textContent = "取得できませんでした";
        this.elements.downloadAck.disabled = true;
        this.elements.downloadAck.textContent = "容量を確認できません";
        this.elements.downloadStatus.textContent = "実際の容量を確認できませんでした。再読み込みしてからもう一度お試しください。";
      }
    }
  }

  async #runVoiceDownload() {
    if (this.downloadRunning) {
      await this.#cancelVoiceDownload();
      return;
    }
    if (this.downloadCompleted || !this.downloadAcknowledged) return;
    const voiceRuntime = this.app?.voiceRuntime;
    if (!voiceRuntime?.subscribeProgress || !this.app?.prepareOfflineVoice) {
      this.elements.downloadStatus.textContent = "音声ダウンロードを開始できません。";
      return;
    }

    this.downloadRunning = true;
    this.downloadAbortController = new AbortController();
    this.downloadProgressLast = null;
    this.elements.downloadButton.disabled = false;
    this.elements.downloadButton.textContent = "ダウンロードを中止";
    this.elements.downloadButton.classList.add("tutorial-download-cancel");
    this.elements.back.disabled = true;
    this.elements.next.disabled = true;
    this.elements.downloadStatus.textContent = "ダウンロード中です。中止すると進行中の通信も止まります。";
    this.downloadProgressUnsubscribe?.();
    this.downloadProgressUnsubscribe = voiceRuntime.subscribeProgress((message) => this.#handleDownloadProgress(message));

    try {
      const profile = this.modelProfileUi?.profile ?? "fp16";
      const task = this.app.prepareOfflineVoice(profile, {
        onKanalizerStatus: () => {
          this.elements.downloadStatus.textContent = "オフラインで使うための仕上げをしています。";
        },
        signal: this.downloadAbortController.signal,
      });
      this.downloadTask = task;
      await task;
      this.downloadCompleted = true;
      this.elements.downloadProgress.value = 100;
      this.elements.downloadPercent.textContent = "100%";
      this.elements.downloadButton.textContent = "ダウンロード完了";
      this.elements.downloadButton.classList.remove("tutorial-download-cancel");
      this.elements.downloadStatus.textContent = "保存が終わりました。これでオフラインでも使えます。「使い始める」のあとに音声を読み込みます。";
      this.elements.downloadSpeed.textContent = "完了";
      this.elements.next.disabled = false;
      this.#updateHighlights("download");
      this.elements.next.focus({ preventScroll: true });
    } catch (error) {
      if (error?.name === "AbortError") {
        this.elements.downloadStatus.textContent = "ダウンロードを中止しました。進行中の通信も停止しました。";
        this.elements.downloadSpeed.textContent = "中止";
      } else {
        this.elements.downloadStatus.textContent = `ダウンロードに失敗しました: ${error instanceof Error ? error.message : String(error)}`;
      }
    } finally {
      this.downloadProgressUnsubscribe?.();
      this.downloadProgressUnsubscribe = null;
      this.downloadTask = null;
      this.downloadAbortController = null;
      this.downloadRunning = false;
      this.elements.back.disabled = this.stepIndex === 0;
      if (!this.downloadCompleted) {
        this.elements.downloadButton.disabled = false;
        this.elements.downloadButton.textContent = "音声データをダウンロード";
        this.elements.downloadButton.classList.remove("tutorial-download-cancel");
      }
    }
  }

  async #cancelVoiceDownload() {
    const controller = this.downloadAbortController;
    const task = this.downloadTask;
    if (!controller || controller.signal.aborted) return;
    this.elements.downloadButton.disabled = true;
    this.elements.downloadButton.textContent = "中止しています…";
    controller.abort(new DOMException("Download cancelled by user", "AbortError"));
    try {
      await task;
    } catch {
      // The active download path reports the final cancelled state.
    }
  }

  #handleDownloadProgress(message) {
    if (message.stage !== "download") return;
    const loaded = Number(message.loadedBytes || 0);
    const total = Number(message.totalBytes || 0);
    if (total > 0) {
      const percent = Math.max(0, Math.min(100, loaded / total * 100));
      this.elements.downloadProgress.value = percent;
      this.elements.downloadPercent.textContent = `${percent.toFixed(1)}%`;
      this.elements.downloadBytes.textContent = `${this.#formatBytes(loaded)} / ${this.#formatBytes(total)}`;
    }

    const now = performance.now();
    if (message.phase === "downloading") {
      if (this.downloadProgressLast && loaded >= this.downloadProgressLast.loaded) {
        const elapsedSeconds = (now - this.downloadProgressLast.at) / 1000;
        const deltaBytes = loaded - this.downloadProgressLast.loaded;
        if (elapsedSeconds >= 0.08 && deltaBytes > 0) {
          const megabytesPerSecond = deltaBytes / elapsedSeconds / 1_000_000;
          this.elements.downloadSpeed.textContent = `${megabytesPerSecond.toFixed(1)} MB/s`;
        }
      } else {
        this.elements.downloadSpeed.textContent = "計測中…";
      }
      this.downloadProgressLast = { loaded, at: now };
      this.elements.downloadStatus.textContent = "ダウンロード中です。";
      return;
    }

    this.downloadProgressLast = null;
    if (message.phase === "verifying-cache") {
      this.elements.downloadSpeed.textContent = "キャッシュ確認中";
      this.elements.downloadStatus.textContent = "保存済みデータを確認しています。";
    } else if (message.phase === "verified-cache") {
      this.elements.downloadSpeed.textContent = "キャッシュ済み";
      this.elements.downloadStatus.textContent = "保存済みデータを利用できます。";
    } else if (message.phase === "verified") {
      this.elements.downloadStatus.textContent = "ダウンロードしたデータを検証しました。";
    }
  }

  #formatBytes(bytes) {
    const value = Math.max(0, Number(bytes) || 0);
    if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(2)} GiB`;
    if (value >= 1024 ** 2) return `${(value / 1024 ** 2).toFixed(1)} MiB`;
    if (value >= 1024) return `${(value / 1024).toFixed(1)} KiB`;
    return `${Math.round(value)} B`;
  }

  async #runLinebreakDemo() {
    if (this.demoRunning) return;
    this.demoRunning = true;
    const runToken = ++this.demoRunToken;
    this.elements.linebreakDemo.disabled = true;
    this.elements.back.disabled = true;
    this.elements.next.disabled = true;

    const composer = this.elements.composer;
    this.#rememberComposer();
    const text = this.#pickDemoText();
    composer.classList.add("tutorial-target", "tutorial-demo-active");
    this.elements.demoStatus.textContent = "文字を少しずつ入力してみます。";

    try {
      this.#moveCaretToEnd();
      if (composer.value && !composer.value.endsWith("\n")) {
        composer.setRangeText("\n", composer.selectionStart, composer.selectionEnd, "end");
      }
      if (!await this.#typeText(text, runToken)) return;

      if (runToken !== this.demoRunToken) return;
      this.elements.demoStatus.textContent = "入力できました。ここで改行します。";
      await this.#sleep(260);
      if (runToken !== this.demoRunToken) return;

      const beforePending = this.app?.tutorialPendingCount ?? 0;
      this.#insertLineBreakAtCaret();
      if (!await this.#waitForPendingIncrease(beforePending, runToken)) return;
      this.elements.demoStatus.textContent = "読み上げ待ちに入りました。";

      await this.#sleep(420);
      if (runToken !== this.demoRunToken) return;
      await this.app?.cancelLatestTutorialPending?.();
      this.#appendDemoHistory(text);
      this.elements.demoStatus.textContent = "読み上げ履歴に追加されました。3行を超えると、いちばん古い行は入力欄から消えます。もう一度試せます。";
    } finally {
      if (runToken === this.demoRunToken) {
        this.demoRunning = false;
        this.elements.linebreakDemo.disabled = false;
        this.elements.back.disabled = this.stepIndex === 0;
        this.elements.next.disabled = false;
      }
    }
  }

  async #runCorrectionDemo() {
    if (this.demoRunning) return;
    this.demoRunning = true;
    const runToken = ++this.demoRunToken;
    this.elements.correctionDemo.disabled = true;
    this.elements.back.disabled = true;
    this.elements.next.disabled = true;
    this.#rememberComposer();

    try {
      while ((this.app?.tutorialPendingCount ?? 0) > 0) {
        if (!await this.app?.cancelLatestTutorialPending?.()) break;
      }

      const currentLines = this.elements.composer.value
        .replace(/\r\n?/g, "\n")
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .slice(-2);
      const first = currentLines[0] ?? this.#pickDemoText();
      let second = currentLines[1] ?? this.#pickDemoText();
      if (second === first) second = DEMO_TEXTS.find((text) => text !== first) ?? DEMO_TEXTS[0];
      if (!await this.#seedCorrectionPendingPair(first, second, runToken)) return;

      const correction = this.#pickCorrectionText(first);
      this.elements.correctionStatus.textContent = "1行目の差分だけを、1文字ずつ直しています。";
      if (!await this.#replaceFirstSubmittedLine(correction, runToken)) return;

      this.elements.correctionStatus.textContent = "1行目を直した状態で、実際の「現在の文章で訂正する」を押します。";
      await this.#pressRealButton(this.elements.correctionButton, runToken);
      if (!await this.#waitForAnyPendingText(correction, runToken)) return;
      this.#renderDemoHistory();
      this.elements.correctionStatus.textContent = "1行目だけ訂正されました。これは操作例なので、ここでは通常の訂正対象数の制限を無視しています。";
    } finally {
      if (runToken === this.demoRunToken) {
        this.demoRunning = false;
        this.elements.correctionDemo.disabled = false;
        this.elements.back.disabled = this.stepIndex === 0;
        this.elements.next.disabled = false;
      }
    }
  }

  async #prepareCancelExample() {
    if (this.cancelExamplePreparing || this.demoRunning) return;
    if (this.app?.latestTutorialPendingText === CANCEL_DEMO_TEXT) return;
    this.cancelExamplePreparing = true;
    this.demoRunning = true;
    const runToken = ++this.demoRunToken;
    this.elements.cancelDemo.disabled = true;
    this.elements.back.disabled = true;
    this.elements.next.disabled = true;
    this.#rememberComposer();

    try {
      await this.app?.cancelLatestTutorialPending?.();
      this.#renderDemoHistory();
      const composer = this.elements.composer;
      this.#moveCaretToEnd();
      if (composer.value && !composer.value.endsWith("\n")) {
        composer.setRangeText("\n", composer.selectionStart, composer.selectionEnd, "end");
      }
      this.elements.cancelStatus.textContent = "取り消すための文章を、1文字ずつ入力しています。";
      if (!await this.#typeText(CANCEL_DEMO_TEXT, runToken)) return;
      const beforePending = this.app?.tutorialPendingCount ?? 0;
      this.#insertLineBreakAtCaret();
      if (!await this.#waitForPendingIncrease(beforePending, runToken)) return;
      this.#renderDemoHistory();
      this.#updateHighlights("cancel");
      this.elements.cancelStatus.textContent = "読み上げ待ちに入りました。オレンジで囲まれた「取り消す」を見てください。";
    } finally {
      if (runToken === this.demoRunToken) {
        this.demoRunning = false;
        this.cancelExamplePreparing = false;
        this.elements.cancelDemo.disabled = false;
        this.elements.back.disabled = this.stepIndex === 0;
        this.elements.next.disabled = false;
      }
    }
  }

  async #runCancelDemo() {
    if (this.demoRunning) return;
    if ((this.app?.tutorialPendingCount ?? 0) === 0) await this.#prepareCancelExample();
    if ((this.app?.tutorialPendingCount ?? 0) === 0) return;
    this.demoRunning = true;
    const runToken = ++this.demoRunToken;
    this.elements.cancelDemo.disabled = true;
    this.elements.back.disabled = true;
    this.elements.next.disabled = true;
    const beforePending = this.app?.tutorialPendingCount ?? 0;
    try {
      this.elements.cancelStatus.textContent = "「取り消す」を押します。";
      await this.#pressRealButton(this.elements.cancelCurrentButton, runToken);
      if (!await this.#waitForPendingDecrease(beforePending, runToken)) return;
      this.#renderDemoHistory();
      this.elements.cancelStatus.textContent = "取り消しました。読み上げ待ちから文章が消えました。";
    } finally {
      if (runToken === this.demoRunToken) {
        this.demoRunning = false;
        this.elements.cancelDemo.disabled = false;
        this.elements.back.disabled = this.stepIndex === 0;
        this.elements.next.disabled = false;
      }
    }
  }

  #appendDemoHistory(text) {
    this.demoHistoryTexts.push(text);
    this.#renderDemoHistory();
  }

  #renderDemoHistory() {
    for (const node of this.document.querySelectorAll(".tutorial-demo-message")) node.remove();
    const fragment = this.document.createDocumentFragment();
    for (const text of [...this.demoHistoryTexts].reverse()) {
      const node = this.elements.messageTemplate.content.firstElementChild.cloneNode(true);
      node.classList.add("tutorial-demo-message");
      node.querySelector(".message-text").textContent = text;
      const time = node.querySelector(".message-time");
      const now = new Date();
      time.dateTime = now.toISOString();
      time.textContent = "いま";
      fragment.append(node);
    }
    this.elements.messageList.prepend(fragment);
    this.elements.emptyTimeline.hidden = true;
  }

  #pickDemoText() {
    const candidates = DEMO_TEXTS.filter((text) => text !== this.lastDemoText);
    const text = candidates[Math.floor(Math.random() * candidates.length)] ?? DEMO_TEXTS[0];
    this.lastDemoText = text;
    return text;
  }

  #pickCorrectionText(current) {
    const candidates = CORRECTION_TEXTS.filter((text) => text !== current && text !== this.lastCorrectionText);
    const text = candidates[Math.floor(Math.random() * candidates.length)] ?? CORRECTION_TEXTS[0];
    this.lastCorrectionText = text;
    return text;
  }

  #moveCaretToEnd() {
    const composer = this.elements.composer;
    composer.focus({ preventScroll: true });
    composer.setSelectionRange(composer.value.length, composer.value.length);
  }

  #createInputEvent(type, inputType, data = null) {
    const view = this.document.defaultView ?? globalThis;
    try {
      return new view.InputEvent(type, {
        bubbles: true,
        cancelable: type === "beforeinput",
        inputType,
        data,
      });
    } catch {
      const event = new view.Event(type, { bubbles: true, cancelable: type === "beforeinput" });
      Object.defineProperty(event, "inputType", { value: inputType });
      Object.defineProperty(event, "data", { value: data });
      return event;
    }
  }

  #insertTextAtCaret(text) {
    const composer = this.elements.composer;
    const before = this.#createInputEvent("beforeinput", "insertText", text);
    if (!composer.dispatchEvent(before)) return false;
    composer.setRangeText(text, composer.selectionStart, composer.selectionEnd, "end");
    composer.dispatchEvent(this.#createInputEvent("input", "insertText", text));
    return true;
  }

  #deleteBeforeCaret() {
    const composer = this.elements.composer;
    const start = composer.selectionStart;
    const end = composer.selectionEnd;
    if (start == null || end == null || (start === 0 && end === 0)) return false;
    const before = this.#createInputEvent("beforeinput", "deleteContentBackward");
    if (!composer.dispatchEvent(before)) return false;
    if (start !== end) composer.setRangeText("", start, end, "end");
    else composer.setRangeText("", start - 1, start, "end");
    composer.dispatchEvent(this.#createInputEvent("input", "deleteContentBackward"));
    return true;
  }

  #insertLineBreakAtCaret() {
    const composer = this.elements.composer;
    const before = this.#createInputEvent("beforeinput", "insertLineBreak");
    if (!composer.dispatchEvent(before)) return false;
    composer.setRangeText("\n", composer.selectionStart, composer.selectionEnd, "end");
    composer.dispatchEvent(this.#createInputEvent("input", "insertLineBreak"));
    return true;
  }

  async #typeText(text, runToken, delay = 38) {
    for (const character of [...text]) {
      if (runToken !== this.demoRunToken) return false;
      if (!this.#insertTextAtCaret(character)) return false;
      await this.#sleep(delay);
    }
    return runToken === this.demoRunToken;
  }

  async #waitFor(predicate, runToken, timeoutMs = 2500) {
    const deadline = performance.now() + timeoutMs;
    while (performance.now() < deadline) {
      if (runToken !== this.demoRunToken) return false;
      if (predicate()) return true;
      await this.#sleep(40);
    }
    return false;
  }

  #waitForPendingIncrease(previousCount, runToken) {
    return this.#waitFor(() => (this.app?.tutorialPendingCount ?? 0) > previousCount, runToken);
  }

  #waitForPendingDecrease(previousCount, runToken) {
    return this.#waitFor(() => (this.app?.tutorialPendingCount ?? 0) < previousCount, runToken);
  }

  #waitForPendingText(text, runToken) {
    return this.#waitFor(() => this.app?.latestTutorialPendingText === text, runToken);
  }

  #waitForAnyPendingText(text, runToken) {
    return this.#waitFor(
      () => [...this.elements.pendingList.querySelectorAll(".pending-text")]
        .some((node) => node.textContent === text),
      runToken
    );
  }

  async #seedCorrectionPendingPair(first, second, runToken) {
    const composer = this.elements.composer;
    composer.focus({ preventScroll: true });
    if (composer.value.length > 0) {
      composer.setSelectionRange(0, composer.value.length);
      if (!this.#deleteBeforeCaret()) return false;
    }

    this.elements.correctionStatus.textContent = "まず、訂正前の2行を読み上げ待ちへ送ります。";
    if (!await this.#typeText(first, runToken, 22)) return false;
    let beforePending = this.app?.tutorialPendingCount ?? 0;
    if (!this.#insertLineBreakAtCaret()) return false;
    if (!await this.#waitForPendingIncrease(beforePending, runToken)) return false;

    if (!await this.#typeText(second, runToken, 22)) return false;
    beforePending = this.app?.tutorialPendingCount ?? 0;
    if (!this.#insertLineBreakAtCaret()) return false;
    if (!await this.#waitForPendingIncrease(beforePending, runToken)) return false;
    return runToken === this.demoRunToken;
  }

  #lastSubmittedLineRange() {
    const value = this.elements.composer.value;
    let end = value.length;
    while (end > 0 && value[end - 1] === "\n") end -= 1;
    const start = value.lastIndexOf("\n", Math.max(0, end - 1)) + 1;
    return { start, end, text: value.slice(start, end) };
  }

  #lastSubmittedLine() {
    return this.#lastSubmittedLineRange().text;
  }

  #firstSubmittedLineRange() {
    const value = this.elements.composer.value;
    let start = 0;
    while (start < value.length && value[start] === "\n") start += 1;
    const newline = value.indexOf("\n", start);
    const end = newline === -1 ? value.length : newline;
    return { start, end, text: value.slice(start, end) };
  }

  async #replaceFirstSubmittedLine(nextText, runToken) {
    const composer = this.elements.composer;
    const range = this.#firstSubmittedLineRange();
    let prefixLength = 0;
    while (
      prefixLength < range.text.length
      && prefixLength < nextText.length
      && range.text[prefixLength] === nextText[prefixLength]
    ) prefixLength += 1;

    composer.focus({ preventScroll: true });
    composer.setSelectionRange(range.end, range.end);
    for (let index = range.text.length; index > prefixLength; index -= 1) {
      if (runToken !== this.demoRunToken) return false;
      if (!this.#deleteBeforeCaret()) return false;
      await this.#sleep(34);
    }
    return this.#typeText(nextText.slice(prefixLength), runToken, 34);
  }

  async #replaceLastSubmittedLine(nextText, runToken) {
    const composer = this.elements.composer;
    const range = this.#lastSubmittedLineRange();
    let prefixLength = 0;
    while (
      prefixLength < range.text.length
      && prefixLength < nextText.length
      && range.text[prefixLength] === nextText[prefixLength]
    ) prefixLength += 1;

    composer.focus({ preventScroll: true });
    composer.setSelectionRange(range.end, range.end);
    for (let index = range.text.length; index > prefixLength; index -= 1) {
      if (runToken !== this.demoRunToken) return false;
      if (!this.#deleteBeforeCaret()) return false;
      await this.#sleep(34);
    }
    return this.#typeText(nextText.slice(prefixLength), runToken, 34);
  }

  async #pressRealButton(button, runToken) {
    if (runToken !== this.demoRunToken || button.disabled) return false;
    button.classList.add("tutorial-demo-press");
    button.focus({ preventScroll: true });
    await this.#sleep(120);
    if (runToken !== this.demoRunToken) return false;
    button.click();
    await this.#sleep(220);
    button.classList.remove("tutorial-demo-press");
    return runToken === this.demoRunToken;
  }

  #sleep(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }

  #rememberComposer() {
    if (this.demoSnapshot) return;
    const composer = this.elements.composer;
    this.demoSnapshot = {
      value: composer.value,
      start: composer.selectionStart,
      end: composer.selectionEnd,
    };
  }

  #cleanupDemo() {
    this.demoRunToken += 1;
    this.demoRunning = false;
    this.elements.linebreakDemo.disabled = false;
    this.elements.correctionDemo.disabled = false;
    this.elements.waitDemo.disabled = false;
    this.elements.cancelDemo.disabled = false;
    this.cancelExamplePreparing = false;
    this.#removeWaitDemoPending();
    if (this.demoSnapshot) {
      const composer = this.elements.composer;
      composer.value = this.demoSnapshot.value;
      composer.setSelectionRange(this.demoSnapshot.start, this.demoSnapshot.end);
      this.demoSnapshot = null;
    }
    for (const target of this.document.querySelectorAll(".tutorial-target, .tutorial-demo-active")) {
      target.classList.remove("tutorial-target", "tutorial-demo-active");
    }
    for (const node of this.document.querySelectorAll(".tutorial-demo-message")) node.remove();
    this.demoHistoryTexts = [];
    this.elements.emptyTimeline.hidden = this.elements.messageList.children.length > 0;
    this.elements.demoStatus.textContent = "音声はまだ読み込みません。何度でも試せます。";
    this.elements.correctionStatus.textContent = "例文を1文字ずつ直して、実際の訂正ボタンを押します。";
    this.elements.waitStatus.textContent = "ここで変えた値は、そのまま本体の設定にも反映されます。";
    this.elements.cancelStatus.textContent = "まず、取り消すための文章を送ります。";
  }


  #updateHighlights(step) {
    for (const target of this.document.querySelectorAll(".tutorial-target")) target.classList.remove("tutorial-target");
    let primaryTarget = null;
    if (step === "linebreak") {
      this.elements.composer.classList.add("tutorial-target");
      primaryTarget = this.elements.composer;
    }

    if (step === "correction") {
      this.elements.correctionButton.classList.add("tutorial-target");
      primaryTarget = this.elements.correctionButton;
    }
    if (step === "wait") {
      this.elements.reasoningSeconds.classList.add("tutorial-target");
      primaryTarget = this.elements.reasoningSeconds;
    }
    if (step === "cancel") {
      this.elements.cancelCurrentButton.classList.add("tutorial-target");
      primaryTarget = this.elements.cancelCurrentButton;
    }
    if (step === "conversations") {
      if (!this.conversationTutorialCompleted) {
        const row = this.elements.conversationList.querySelector('[data-tutorial-conversation="true"]');
        const conversationPanelVisible = !this.elements.conversationPanel.hidden;
        const target = conversationPanelVisible && row ? row : this.elements.conversationView;
        target.classList.add("tutorial-target");
        primaryTarget = target;
      }
    }
    if (step === "free") {
      this.elements.next.classList.add("tutorial-target");
      primaryTarget = this.elements.next;
    }
    if (step === "download" && !this.downloadCompleted) {
      if (!this.downloadAcknowledged) {
        this.elements.downloadAck.classList.add("tutorial-target");
        primaryTarget = this.elements.downloadAck;
      } else {
        this.elements.downloadButton.classList.add("tutorial-target");
        primaryTarget = this.elements.downloadButton;
      }
    }
    this.targetArrowTarget = primaryTarget;
    requestAnimationFrame(() => this.#refreshTargetArrow());
  }

  #refreshTargetArrow() {
    const arrow = this.elements.targetArrow;
    const target = this.targetArrowTarget;
    if (!target || !target.isConnected || this.elements.overlay.hidden) {
      arrow.hidden = true;
      return;
    }

    const rect = target.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0 || rect.bottom < 0 || rect.top > globalThis.innerHeight) {
      arrow.hidden = true;
      return;
    }

    const viewportWidth = globalThis.innerWidth || this.document.documentElement.clientWidth;
    const viewportHeight = globalThis.innerHeight || this.document.documentElement.clientHeight;
    // The visual tip is where the two arrow-head strokes meet, not the
    // top-left corner of the fixed arrow box. Keep that tip on the target.
    const tipOffsetX = 20;
    const tipOffsetY = 30;
    const desiredTipX = rect.right + 4;
    const desiredTipY = rect.top + rect.height / 2;
    const x = Math.max(8, Math.min(viewportWidth - 112, desiredTipX - tipOffsetX));
    const y = Math.max(8, Math.min(viewportHeight - 210, desiredTipY - tipOffsetY));

    arrow.style.setProperty("--tutorial-target-arrow-x", `${Math.round(x)}px`);
    arrow.style.setProperty("--tutorial-target-arrow-y", `${Math.round(y)}px`);
    arrow.hidden = false;
  }

  #resolveElements() {
    const byId = (id) => {
      const element = this.document.getElementById(id);
      if (!element) throw new Error(`Required tutorial element is missing: ${id}`);
      return element;
    };
    const overlay = byId("tutorial-overlay");
    return {
      overlay,
      pages: [...overlay.querySelectorAll("[data-tutorial-step]")],
      summaryJumpButtons: [...overlay.querySelectorAll("[data-tutorial-jump]")],
      pagesContainer: overlay.querySelector(".tutorial-pages"),
      progress: byId("tutorial-progress"),
      back: byId("tutorial-back"),
      next: byId("tutorial-next"),
      restart: byId("restart-tutorial"),
      linebreakDemo: byId("tutorial-linebreak-demo"),
      correctionDemo: byId("tutorial-correction-demo"),
      waitDemo: byId("tutorial-wait-demo"),
      cancelDemo: byId("tutorial-cancel-demo"),
      conversationStatus: byId("tutorial-conversation-status"),
      freeStatus: byId("tutorial-free-status"),
      sampleButton: byId("tutorial-sample-button"),
      sampleStatus: byId("tutorial-sample-status"),
      downloadSize: byId("tutorial-download-size"),
      downloadAck: byId("tutorial-download-ack"),
      downloadButton: byId("tutorial-download-button"),
      downloadProgress: byId("tutorial-download-progress"),
      downloadPercent: byId("tutorial-download-percent"),
      downloadBytes: byId("tutorial-download-bytes"),
      downloadSpeed: byId("tutorial-download-speed"),
      downloadStatus: byId("tutorial-download-status"),
      demoStatus: byId("tutorial-demo-status"),
      correctionStatus: byId("tutorial-correction-status"),
      waitSeconds: byId("tutorial-reasoning-seconds"),
      waitStatus: byId("tutorial-wait-status"),
      cancelStatus: byId("tutorial-cancel-status"),
      composer: byId("composer"),
      correctionButton: byId("correction-button"),
      reasoningSeconds: byId("reasoning-seconds"),
      cancelCurrentButton: byId("cancel-current-button"),
      voiceEnable: byId("voice-enable"),
      timelineView: byId("timeline-view"),
      conversationView: byId("conversation-view"),
      conversationPanel: byId("conversation-panel"),
      conversationList: byId("conversation-list"),
      pendingList: byId("pending-list"),
      pendingCount: byId("pending-count"),
      pendingTemplate: byId("pending-template"),
      messageList: byId("message-list"),
      messageTemplate: byId("message-template"),
      emptyTimeline: byId("empty-timeline"),
      targetArrow: byId("tutorial-target-arrow"),
    };
  }
}
