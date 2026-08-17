const MODEL_PROFILE_STORAGE_KEY = "typed-voice-ui-model-profile-v1";
const DEFAULT_MODEL_PROFILE = "fp16";

export const MODEL_PROFILES = Object.freeze({
  fp32: Object.freeze({
    title: "最高品質",
    device: "GPU",
    quality: "最高音質",
    precision: "FP32",
    size: "約2.38 GiB",
    recommended: false,
  }),
  fp16: Object.freeze({
    title: "推奨（おすすめ）",
    device: "GPU",
    quality: "高い",
    precision: "FP16",
    size: "約1.56 GiB",
    recommended: true,
  }),
  "mobile-int8": Object.freeze({
    title: "低メモリ向け",
    device: "CPU",
    quality: "劣化あり",
    precision: "INT8",
    size: "約1.16 GiB",
    recommended: false,
  }),
  "mobile-int4": Object.freeze({
    title: "非推奨",
    device: "CPU",
    quality: "劣化あり",
    precision: "INT4",
    size: "約977 MiB",
    recommended: false,
  }),
});

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
    // UI state remains usable for this page even when storage is unavailable.
  }
}

function normalizeProfile(value) {
  return Object.hasOwn(MODEL_PROFILES, value) ? value : DEFAULT_MODEL_PROFILE;
}

export class ModelProfileUi {
  constructor(documentRef = document, storage = globalThis.localStorage) {
    this.document = documentRef;
    this.storage = storage;
    this.profile = normalizeProfile(safeRead(storage, MODEL_PROFILE_STORAGE_KEY));
    this.controls = [];
    this.settingsButton = null;
    this.settingsPanel = null;
  }

  initialize() {
    this.controls = [...this.document.querySelectorAll("[data-model-profile-control]")];
    for (const control of this.controls) {
      control.addEventListener("change", (event) => {
        const input = event.target.closest('input[type="radio"]');
        if (input) this.select(input.value);
      });
    }
    this.#bindSettingsPanel();
    this.#render();
    return this;
  }

  select(profile) {
    this.profile = normalizeProfile(profile);
    safeWrite(this.storage, MODEL_PROFILE_STORAGE_KEY, this.profile);
    this.#render();
    this.document.dispatchEvent(new CustomEvent("typed-voice:model-profile-ui-change", {
      detail: { profile: this.profile },
    }));
    return this.profile;
  }

  closeSettings() {
    if (!this.settingsButton || !this.settingsPanel) return;
    this.settingsPanel.hidden = true;
    this.settingsButton.setAttribute("aria-expanded", "false");
  }

  #bindSettingsPanel() {
    this.settingsButton = this.document.getElementById("settings-button");
    this.settingsPanel = this.document.getElementById("settings-panel");
    const closeButton = this.document.getElementById("settings-close");
    if (!this.settingsButton || !this.settingsPanel || !closeButton) return;

    this.settingsButton.addEventListener("click", () => {
      const open = this.settingsPanel.hidden;
      this.settingsPanel.hidden = !open;
      this.settingsButton.setAttribute("aria-expanded", String(open));
    });
    closeButton.addEventListener("click", () => this.closeSettings());
    this.document.addEventListener("pointerdown", (event) => {
      if (this.settingsPanel.hidden) return;
      if (this.settingsPanel.contains(event.target) || this.settingsButton.contains(event.target)) return;
      this.closeSettings();
    });
    this.document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") this.closeSettings();
    });
  }

  #render() {
    const profile = MODEL_PROFILES[this.profile];
    for (const control of this.controls) {
      for (const input of control.querySelectorAll('input[type="radio"]')) {
        input.checked = input.value === this.profile;
      }
      control.querySelector("[data-model-profile-title]").textContent = profile.title;
      control.querySelector("[data-model-profile-device]").textContent = profile.device;
      control.querySelector("[data-model-profile-quality]").textContent = profile.quality;
      control.querySelector("[data-model-profile-precision]").textContent = profile.precision;
      control.querySelector("[data-model-profile-size]").textContent = `ダウンロード ${profile.size}`;
      const warning = control.querySelector("[data-model-profile-warning]");
      warning.hidden = profile.recommended;
    }
  }
}

export function initializeModelProfileUi(documentRef = document, storage = globalThis.localStorage) {
  return new ModelProfileUi(documentRef, storage).initialize();
}
