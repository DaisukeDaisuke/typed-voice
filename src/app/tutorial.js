const TUTORIAL_STORAGE_KEY = "typed-voice-tutorial-v1-complete";
const DEMO_TEXT = "こんにちは。改行すると、この1行が読み上げ待ちに入ります。";

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
    this.elements = this.#resolveElements();
  }

  initialize() {
    this.elements.back.addEventListener("click", () => this.previous());
    this.elements.next.addEventListener("click", () => this.next());
    this.elements.restart.addEventListener("click", () => {
      safeRemove(this.storage, TUTORIAL_STORAGE_KEY);
      this.modelProfileUi?.closeSettings();
      this.start();
    });
    this.elements.linebreakDemo.addEventListener("click", () => this.#runLinebreakDemo());
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
    this.elements.back.disabled = this.stepIndex === 0;
    this.elements.next.textContent = this.stepIndex === this.elements.pages.length - 1 ? "使い始める" : "次へ";
    this.#updateHighlights(page.dataset.tutorialStep);
    if (["correction", "cancel"].includes(page.dataset.tutorialStep)) this.#ensureDemoPending();
    this.elements.pagesContainer.scrollTop = 0;
    this.elements.next.focus({ preventScroll: true });
  }

  #runLinebreakDemo() {
    const composer = this.elements.composer;
    this.#rememberComposer();
    composer.value = DEMO_TEXT;
    composer.setSelectionRange(composer.value.length, composer.value.length);
    composer.classList.add("tutorial-target", "tutorial-demo-active");
    this.elements.demoStatus.textContent = "入力しました。次にEnterの改行を再現します。";

    requestAnimationFrame(() => {
      composer.value = `${DEMO_TEXT}\n`;
      composer.setSelectionRange(composer.value.length, composer.value.length);
      this.#ensureDemoPending();
      this.elements.demoStatus.textContent = "改行した1行が読み上げ待ちへ移りました。音声モデルは読み込んでいません。";
    });
  }

  #runCancelDemo() {
    this.#ensureDemoPending();
    if (this.demoPending?.isConnected) this.demoPending.remove();
    this.demoPending = null;
    this.#restorePendingCount();
    this.elements.cancelStatus.textContent = "デモ用の読み上げ待ちを取り消しました。実際の会話データは変更していません。";
  }

  #ensureDemoPending() {
    if (this.demoPending?.isConnected) return this.demoPending;
    const node = this.elements.pendingTemplate.content.firstElementChild.cloneNode(true);
    node.classList.add("tutorial-demo-pending", "tutorial-target");
    node.dataset.pendingId = "tutorial-demo";
    node.querySelector(".pending-state").textContent = "読み上げ待ち（チュートリアル）";
    node.querySelector(".pending-timer").textContent = "2.0秒";
    node.querySelector(".pending-text").textContent = DEMO_TEXT;
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
    this.elements.demoStatus.textContent = "デモは入力欄と待ち表示だけを動かし、音声モデルは読み込みません。";
    this.elements.cancelStatus.textContent = "デモ用の読み上げ待ちだけを消します。";
  }

  #restorePendingCount() {
    if (this.demoPendingCountSnapshot == null) return;
    this.elements.pendingCount.textContent = this.demoPendingCountSnapshot;
    this.demoPendingCountSnapshot = null;
  }

  #updateHighlights(step) {
    for (const target of this.document.querySelectorAll(".tutorial-target")) target.classList.remove("tutorial-target");
    if (step === "linebreak") {
      this.elements.composer.classList.add("tutorial-target");
      return;
    }
    if (step === "correction") {
      this.elements.composer.classList.add("tutorial-target");
      this.elements.correctionButton.classList.add("tutorial-target");
      return;
    }
    if (step === "cancel") {
      this.elements.cancelCurrentButton.classList.add("tutorial-target");
      this.demoPending?.classList.add("tutorial-target");
    }
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
    };
  }
}
