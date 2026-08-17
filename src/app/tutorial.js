const TUTORIAL_STORAGE_KEY = "typed-voice-tutorial-v1-complete";
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
  constructor(documentRef = document, { modelProfileUi = null, storage = globalThis.localStorage } = {}) {
    this.document = documentRef;
    this.modelProfileUi = modelProfileUi;
    this.storage = storage;
    this.stepIndex = 0;
    this.demoSnapshot = null;
    this.demoPending = null;
    this.demoPendingCountSnapshot = null;
    this.demoRunToken = 0;
    this.demoRunning = false;
    this.lastDemoText = null;
    this.targetArrowTarget = null;
    this.elements = this.#resolveElements();
  }

  initialize() {
    this.elements.overlay.addEventListener("pointerdown", () => this.#acknowledgeStep());
    this.elements.overlay.addEventListener("keydown", () => this.#acknowledgeStep());
    globalThis.addEventListener?.("resize", () => this.#refreshTargetArrow(), { passive: true });
    this.document.addEventListener("scroll", () => this.#refreshTargetArrow(), { capture: true, passive: true });
    this.elements.back.addEventListener("click", () => this.previous());
    this.elements.next.addEventListener("click", () => this.next());
    this.elements.restart.addEventListener("click", () => {
      safeRemove(this.storage, TUTORIAL_STORAGE_KEY);
      this.modelProfileUi?.closeSettings();
      this.start();
    });
    this.elements.linebreakDemo.addEventListener("click", () => void this.#runLinebreakDemo());
    this.elements.cancelDemo.addEventListener("click", () => this.#runCancelDemo());

    if (safeRead(this.storage, TUTORIAL_STORAGE_KEY) !== "1") this.start();
    return this;
  }

  start() {
    this.#cleanupDemo();
    this.stepIndex = 0;
    this.elements.overlay.hidden = false;
    this.document.body.classList.add("tutorial-open");
    this.#showStep();
  }

  previous() {
    if (this.stepIndex === 0) return;
    this.stepIndex -= 1;
    this.#showStep();
  }

  next() {
    if (this.stepIndex >= this.elements.pages.length - 1) {
      this.complete();
      return;
    }
    this.stepIndex += 1;
    this.#showStep();
  }

  complete() {
    safeWrite(this.storage, TUTORIAL_STORAGE_KEY, "1");
    this.#cleanupDemo();
    this.elements.overlay.hidden = true;
    this.document.body.classList.remove("tutorial-open");
    this.elements.composer.focus({ preventScroll: true });
  }

  #showStep() {
    const page = this.elements.pages[this.stepIndex];
    for (const [index, candidate] of this.elements.pages.entries()) {
      candidate.hidden = index !== this.stepIndex;
    }
    this.elements.overlay.classList.toggle("tutorial-live", page.dataset.tutorialLive === "true");
    this.elements.overlay.dataset.step = page.dataset.tutorialStep;
    this.elements.progress.textContent = `${this.stepIndex + 1} / ${this.elements.pages.length}`;
    this.elements.overlay.classList.add("tutorial-needs-attention");
    this.elements.back.disabled = this.stepIndex === 0;
    this.elements.next.textContent = this.stepIndex === this.elements.pages.length - 1 ? "使い始める" : "次へ";
    this.#updateHighlights(page.dataset.tutorialStep);
    if (["correction", "cancel"].includes(page.dataset.tutorialStep)) this.#ensureDemoPending();
    this.elements.pagesContainer.scrollTop = 0;
    this.elements.next.focus({ preventScroll: true });
  }

  #acknowledgeStep() {
    this.elements.overlay.classList.remove("tutorial-needs-attention");
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
    composer.value = "";
    composer.classList.add("tutorial-target", "tutorial-demo-active");
    this.elements.demoStatus.textContent = "文字を少しずつ入力してみます。";

    try {
      for (const character of [...text]) {
        if (runToken !== this.demoRunToken) return;
        composer.value += character;
        composer.setSelectionRange(composer.value.length, composer.value.length);
        await this.#sleep(42);
      }

      if (runToken !== this.demoRunToken) return;
      this.elements.demoStatus.textContent = "入力できました。ここで改行します。";
      await this.#sleep(260);
      if (runToken !== this.demoRunToken) return;

      composer.value = `${text}\n`;
      composer.setSelectionRange(composer.value.length, composer.value.length);
      this.#ensureDemoPending(text);
      this.elements.demoStatus.textContent = "読み上げ待ちに入りました。";

      await this.#sleep(650);
      if (runToken !== this.demoRunToken) return;
      if (this.demoPending?.isConnected) this.demoPending.remove();
      this.demoPending = null;
      this.#restorePendingCount();
      this.#appendDemoHistory(text);
      this.elements.demoStatus.textContent = "読み上げ履歴に追加されました。もう一度押すと、別の文章でも試せます。";
    } finally {
      if (runToken === this.demoRunToken) {
        this.demoRunning = false;
        this.elements.linebreakDemo.disabled = false;
        this.elements.back.disabled = this.stepIndex === 0;
        this.elements.next.disabled = false;
      }
    }
  }

  #runCancelDemo() {
    this.#ensureDemoPending();
    if (this.demoPending?.isConnected) this.demoPending.remove();
    this.demoPending = null;
    this.#restorePendingCount();
    this.elements.cancelStatus.textContent = "デモ用の読み上げ待ちを取り消しました。実際の会話データは変更していません。";
  }

  #ensureDemoPending(text = this.lastDemoText ?? DEMO_TEXTS[0]) {
    if (this.demoPending?.isConnected) return this.demoPending;
    const node = this.elements.pendingTemplate.content.firstElementChild.cloneNode(true);
    node.classList.add("tutorial-demo-pending", "tutorial-target");
    node.dataset.pendingId = "tutorial-demo";
    node.querySelector(".pending-state").textContent = "読み上げ待ち（チュートリアル）";
    node.querySelector(".pending-timer").textContent = "2.0秒";
    node.querySelector(".pending-text").textContent = text;
    const cancel = node.querySelector(".pending-cancel");
    cancel.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.#runCancelDemo();
    });
    this.elements.pendingList.prepend(node);
    if (this.demoPendingCountSnapshot == null) {
      this.demoPendingCountSnapshot = this.elements.pendingCount.textContent;
      const currentCount = Number.parseInt(this.demoPendingCountSnapshot, 10);
      this.elements.pendingCount.textContent = String((Number.isFinite(currentCount) ? currentCount : 0) + 1);
    }
    this.demoPending = node;
    return node;
  }

  #appendDemoHistory(text) {
    const node = this.elements.messageTemplate.content.firstElementChild.cloneNode(true);
    node.classList.add("tutorial-demo-message", "tutorial-target");
    node.querySelector(".message-text").textContent = text;
    const time = node.querySelector(".message-time");
    const now = new Date();
    time.dateTime = now.toISOString();
    time.textContent = "いま";
    this.elements.messageList.append(node);
    this.elements.emptyTimeline.hidden = true;
  }

  #pickDemoText() {
    const candidates = DEMO_TEXTS.filter((text) => text !== this.lastDemoText);
    const text = candidates[Math.floor(Math.random() * candidates.length)] ?? DEMO_TEXTS[0];
    this.lastDemoText = text;
    return text;
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
    if (this.demoPending?.isConnected) this.demoPending.remove();
    this.demoPending = null;
    this.#restorePendingCount();
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
    this.elements.emptyTimeline.hidden = this.elements.messageList.children.length > 0;
    this.elements.demoStatus.textContent = "音声はまだ読み込みません。何度でも試せます。";
    this.elements.cancelStatus.textContent = "デモ用の読み上げ待ちだけを消します。";
  }

  #restorePendingCount() {
    if (this.demoPendingCountSnapshot == null) return;
    this.elements.pendingCount.textContent = this.demoPendingCountSnapshot;
    this.demoPendingCountSnapshot = null;
  }

  #updateHighlights(step) {
    for (const target of this.document.querySelectorAll(".tutorial-target")) target.classList.remove("tutorial-target");
    let primaryTarget = null;
    if (step === "linebreak") {
      this.elements.composer.classList.add("tutorial-target");
      primaryTarget = this.elements.composer;
    }
    if (step === "correction") {
      this.elements.composer.classList.add("tutorial-target");
      this.elements.correctionButton.classList.add("tutorial-target");
      primaryTarget = this.elements.correctionButton;
    }
    if (step === "cancel") {
      this.elements.cancelCurrentButton.classList.add("tutorial-target");
      this.demoPending?.classList.add("tutorial-target");
      primaryTarget = this.elements.cancelCurrentButton;
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

    const shellRect = this.elements.overlay.querySelector(".tutorial-shell")?.getBoundingClientRect();
    if (!shellRect) {
      arrow.hidden = true;
      return;
    }

    const viewportWidth = globalThis.innerWidth || this.document.documentElement.clientWidth;
    const viewportHeight = globalThis.innerHeight || this.document.documentElement.clientHeight;
    const targetCenterX = rect.left + rect.width / 2;
    const targetCenterY = rect.top + rect.height / 2;
    const sourceCenterX = shellRect.left + shellRect.width / 2;
    const sourceCenterY = shellRect.top + shellRect.height / 2;
    const dx = targetCenterX - sourceCenterX;
    const dy = targetCenterY - sourceCenterY;
    const desiredAngle = Math.atan2(dy, dx) * 180 / Math.PI;
    const rotation = desiredAngle - 180;

    let anchorX = targetCenterX;
    let anchorY = targetCenterY;
    if (Math.abs(dx) >= Math.abs(dy)) {
      anchorX = dx < 0 ? rect.right + 12 : rect.left - 12;
    } else {
      anchorY = dy < 0 ? rect.bottom + 12 : rect.top - 12;
    }

    const headX = 18;
    const headY = 21;
    const x = Math.max(-120, Math.min(viewportWidth - 30, anchorX - headX));
    const y = Math.max(-100, Math.min(viewportHeight - 30, anchorY - headY));

    arrow.style.setProperty("--tutorial-target-arrow-x", `${Math.round(x)}px`);
    arrow.style.setProperty("--tutorial-target-arrow-y", `${Math.round(y)}px`);
    arrow.style.setProperty("--tutorial-target-arrow-rotation", `${rotation.toFixed(1)}deg`);
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
      pagesContainer: overlay.querySelector(".tutorial-pages"),
      progress: byId("tutorial-progress"),
      back: byId("tutorial-back"),
      next: byId("tutorial-next"),
      restart: byId("restart-tutorial"),
      linebreakDemo: byId("tutorial-linebreak-demo"),
      cancelDemo: byId("tutorial-cancel-demo"),
      demoStatus: byId("tutorial-demo-status"),
      cancelStatus: byId("tutorial-cancel-status"),
      composer: byId("composer"),
      correctionButton: byId("correction-button"),
      cancelCurrentButton: byId("cancel-current-button"),
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
