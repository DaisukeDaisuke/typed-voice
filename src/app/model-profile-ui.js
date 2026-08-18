const MODEL_PROFILE_STORAGE_KEY = "typed-voice-ui-model-profile-v1";
const DEFAULT_MODEL_PROFILE = "fp16";

export const MODEL_PROFILES = Object.freeze({
  fp32: Object.freeze({
    title: "最高品質",
    speed: "高速合成（サポートしている場合）",
    device: "GPU",
    quality: "最高音質",
    precision: "FP32",
    size: "約2.38 GiB",
    recommended: false,
  }),
  fp16: Object.freeze({
    title: "推奨（おすすめ）",
    speed: "高速合成（サポートしている場合）",
    device: "GPU",
    quality: "高い",
    precision: "FP16",
    size: "約1.56 GiB",
    recommended: true,
  }),
  "mobile-int8": Object.freeze({
    title: "低メモリ向け",
    speed: "低速合成",
    device: "CPU",
    quality: "劣化あり",
    precision: "INT8",
    size: "約1.16 GiB",
    recommended: false,
  }),
  "mobile-int4": Object.freeze({
    title: "非推奨",
    speed: "低速合成",
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
    this.committedProfile = normalizeProfile(safeRead(storage, MODEL_PROFILE_STORAGE_KEY));
    this.profile = this.committedProfile;
    this.remoteProfile = null;
    this.controls = [];
    this.settingsButton = null;
    this.settingsPanel = null;
  }

  initialize() {
    this.controls = [...this.document.querySelectorAll("[data-model-profile-control]")];
    for (const control of this.controls) {
      const readOnly = control.hasAttribute("data-model-profile-readonly");
      for (const input of control.querySelectorAll('input[type="radio"]')) input.disabled = readOnly;
      if (readOnly) continue;
      control.addEventListener("change", (event) => {
        const input = event.target.closest('input[type="radio"]');
        if (!input) return;
        const persist = !control.hasAttribute("data-model-profile-deferred");
        this.select(input.value, { persist });
      });
    }
    this.#bindSettingsPanel();
    this.#render();
    return this;
  }

  select(profile, { persist = true } = {}) {
    if (this.remoteProfile) return this.remoteProfile;
    this.profile = normalizeProfile(profile);
    if (persist) {
      this.committedProfile = this.profile;
      safeWrite(this.storage, MODEL_PROFILE_STORAGE_KEY, this.profile);
    }
    this.#render();
    this.document.dispatchEvent(new CustomEvent("typed-voice:model-profile-ui-change", {
      detail: {
        profile: this.profile,
        committedProfile: this.committedProfile,
        persisted: persist,
      },
    }));
    return this.profile;
  }

  commitSelection() {
    this.committedProfile = normalizeProfile(this.profile);
    safeWrite(this.storage, MODEL_PROFILE_STORAGE_KEY, this.committedProfile);
    this.#render();
    this.document.dispatchEvent(new CustomEvent("typed-voice:model-profile-committed", {
      detail: { profile: this.committedProfile },
    }));
    return this.committedProfile;
  }

  restoreCommittedSelection() {
    if (this.remoteProfile) return this.remoteProfile;
    this.profile = this.committedProfile;
    this.#render();
    this.document.dispatchEvent(new CustomEvent("typed-voice:model-profile-ui-change", {
      detail: {
        profile: this.profile,
        committedProfile: this.committedProfile,
        persisted: true,
        restored: true,
      },
    }));
    return this.profile;
  }

  closeSettings() {
    if (!this.settingsButton || !this.settingsPanel) return;
    this.settingsPanel.hidden = true;
    this.settingsButton.setAttribute("aria-expanded", "false");
  }

  setRemoteProfile(profile) {
    this.remoteProfile = normalizeProfile(profile);
    this.#render();
    this.document.dispatchEvent(new CustomEvent("typed-voice:remote-model-profile", {
      detail: { profile: this.remoteProfile },
    }));
    return this.remoteProfile;
  }

  clearRemoteProfile() {
    this.remoteProfile = null;
    this.#render();
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
    for (const control of this.controls) {
      const readOnly = this.remoteProfile !== null || control.hasAttribute("data-model-profile-readonly");
      const selectedProfile = this.remoteProfile ?? (readOnly ? this.committedProfile : this.profile);
      const profile = MODEL_PROFILES[selectedProfile];
      for (const input of control.querySelectorAll('input[type="radio"]')) {
        input.checked = input.value === selectedProfile;
        input.disabled = readOnly;
      }
      control.querySelector("[data-model-profile-title]").textContent = profile.title;
      control.querySelector("[data-model-profile-speed]").textContent = profile.speed;
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
