function clampRatio(value, total) {
  const numerator = Math.max(0, Number(value) || 0);
  const denominator = Math.max(0, Number(total) || 0);
  if (denominator <= 0) return 0;
  return Math.max(0, Math.min(1, numerator / denominator));
}

export class BlockingTaskOrchestrator {
  constructor(documentRef = document) {
    this.document = documentRef;
    this.tasks = [];
    this.elements = this.#resolveElements();
    this.running = 0;
    this.finished = false;
    this.fadeTimer = null;
    this.#render();
  }

  async registerBlockingAsync(label, task, { optional = false } = {}) {
    const state = {
      id: crypto.randomUUID(),
      label: String(label || "読み込み"),
      status: "pending",
      detail: "",
      primary: null,
      secondary: null,
    };
    this.tasks.push(state);
    this.running += 1;
    this.finished = false;
    globalThis.clearTimeout(this.fadeTimer);
    this.fadeTimer = null;
    this.elements.root.classList.remove("is-fading");
    this.elements.root.hidden = false;
    this.#render();
    const report = (update = {}) => {
      if (typeof update.detail === "string") state.detail = update.detail;
      if (update.primary) state.primary = { ...update.primary };
      if (update.secondary) state.secondary = { ...update.secondary };
      this.#render();
    };
    state.status = "running";
    this.#render();
    try {
      const result = await task({ report, task: state });
      state.status = "done";
      return result;
    } catch (error) {
      state.status = optional ? "skipped" : "error";
      state.detail = error instanceof Error ? error.message : String(error);
      if (!optional) throw error;
      return null;
    } finally {
      this.running = Math.max(0, this.running - 1);
      this.#render();
    }
  }

  finish() {
    this.finished = true;
    this.#render();
    if (this.running === 0) this.#fadeOut();
  }

  #render() {
    const completed = this.tasks.filter((task) => task.status === "done" || task.status === "skipped").length;
    this.elements.count.textContent = `${completed} / ${this.tasks.length}`;
    const fragment = this.document.createDocumentFragment();
    for (const task of this.tasks) {
      const cell = this.document.createElement("span");
      cell.className = `blocking-loader-cell is-${task.status}`;
      cell.title = task.label;
      cell.setAttribute("aria-label", `${task.label}: ${task.status}`);
      fragment.append(cell);
    }
    this.elements.cells.replaceChildren(fragment);

    const active = [...this.tasks].reverse().find((task) => task.status === "running")
      ?? [...this.tasks].reverse().find((task) => task.status === "error" || task.status === "skipped")
      ?? this.tasks.at(-1)
      ?? null;
    this.elements.label.textContent = active?.label ?? "typed-voiceを読み込んでいます";
    this.elements.detail.textContent = active?.detail || "起動準備中…";
    this.#renderProgress(this.elements.primary, active?.primary);
    this.#renderProgress(this.elements.secondary, active?.secondary);
    if (this.finished && this.running === 0) this.#fadeOut();
  }

  #fadeOut() {
    if (this.elements.root.hidden || this.elements.root.classList.contains("is-fading")) return;
    this.elements.root.classList.add("is-fading");
    globalThis.clearTimeout(this.fadeTimer);
    this.fadeTimer = globalThis.setTimeout(() => {
      if (this.running > 0 || !this.finished) return;
      this.elements.root.hidden = true;
      this.elements.root.classList.remove("is-fading");
      this.fadeTimer = null;
    }, 1000);
  }

  #renderProgress(elements, progress) {
    if (!progress || !Number.isFinite(Number(progress.total)) || Number(progress.total) <= 0) {
      elements.root.hidden = true;
      return;
    }
    const value = Math.max(0, Number(progress.value) || 0);
    const total = Math.max(1, Number(progress.total) || 1);
    elements.root.hidden = false;
    elements.label.textContent = progress.label || "進捗";
    elements.value.textContent = progress.text || `${Math.min(value, total)} / ${total}`;
    elements.fill.style.inlineSize = `${clampRatio(value, total) * 100}%`;
  }

  #resolveElements() {
    const byId = (id) => {
      const element = this.document.getElementById(id);
      if (!element) throw new Error(`Required blocking-loader element is missing: ${id}`);
      return element;
    };
    const progress = (prefix) => ({
      root: byId(`${prefix}-progress`),
      label: byId(`${prefix}-label`),
      value: byId(`${prefix}-value`),
      fill: byId(`${prefix}-fill`),
    });
    return {
      root: byId("blocking-loader"),
      cells: byId("blocking-loader-cells"),
      count: byId("blocking-loader-count"),
      label: byId("blocking-loader-label"),
      detail: byId("blocking-loader-detail"),
      primary: progress("blocking-loader-primary"),
      secondary: progress("blocking-loader-secondary"),
    };
  }
}

export function createBlockingTaskOrchestrator(documentRef = document) {
  return new BlockingTaskOrchestrator(documentRef);
}
