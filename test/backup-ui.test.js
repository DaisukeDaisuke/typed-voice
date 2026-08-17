import test from "node:test";
import assert from "node:assert/strict";
import { BackupUiController } from "../src/app/backup-ui.js";

const ELEMENT_IDS = [
  "backup-export-button",
  "backup-import-button",
  "backup-import-input",
  "backup-settings-status",
  "restart-tutorial",
  "tutorial-restart-dialog",
  "tutorial-restart-backup",
  "tutorial-restart-backup-confirm",
  "tutorial-restart-status",
  "tutorial-restart-cancel",
  "tutorial-restart-confirm",
];

function createElement() {
  const listeners = new Map();
  return {
    hidden: false,
    disabled: false,
    textContent: "",
    files: [],
    value: "",
    addEventListener(type, listener) {
      const list = listeners.get(type) ?? [];
      list.push(listener);
      listeners.set(type, list);
    },
    dispatch(type, event = {}) {
      for (const listener of listeners.get(type) ?? []) listener({ target: this, ...event });
    },
    click() { this.dispatch("click"); },
    focus() {},
  };
}

function createDocument() {
  const elements = new Map(ELEMENT_IDS.map((id) => [id, createElement()]));
  const documentListeners = new Map();
  return {
    elements,
    body: { append() {} },
    getElementById(id) { return elements.get(id) ?? null; },
    addEventListener(type, listener) { documentListeners.set(type, listener); },
    createElement(tagName) {
      if (tagName !== "a") return createElement();
      return {
        href: "",
        download: "",
        hidden: false,
        click() {},
        remove() {},
      };
    },
  };
}

function createBackup() {
  return {
    format: "typed-voice-backup",
    version: 1,
    createdAt: "2026-08-17T11:22:33.000Z",
    database: { name: "typed-voice-app", version: 2, stores: {} },
    localStorage: {},
    uiState: null,
    cacheStorageIncluded: false,
  };
}

function createController(documentRef) {
  return new BackupUiController(documentRef, {
    app: {
      async createBackup() { return createBackup(); },
      async resetForTutorial() {},
      async restoreBackup() {},
    },
    modelProfileUi: { closeSettings() {} },
  }).initialize();
}

function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

async function withSavePicker(picker, run) {
  const hadOwn = Object.hasOwn(globalThis, "showSaveFilePicker");
  const previous = globalThis.showSaveFilePicker;
  globalThis.showSaveFilePicker = picker;
  try {
    await run();
  } finally {
    if (hadOwn) globalThis.showSaveFilePicker = previous;
    else delete globalThis.showSaveFilePicker;
  }
}

test("保存先選択をキャンセルしたら初期化を解禁しない", async () => {
  await withSavePicker(async () => {
    const error = new Error("cancelled");
    error.name = "AbortError";
    throw error;
  }, async () => {
    const documentRef = createDocument();
    const controller = createController(documentRef);
    documentRef.elements.get("restart-tutorial").click();
    documentRef.elements.get("tutorial-restart-backup").click();
    await flush();

    assert.equal(controller.restartBackupVerified, false);
    assert.equal(documentRef.elements.get("tutorial-restart-confirm").disabled, true);
    assert.match(documentRef.elements.get("tutorial-restart-status").textContent, /キャンセル/);
  });
});

test("保存先へ書き込みとcloseが完了した時だけ初期化を解禁する", async () => {
  let closed = false;
  await withSavePicker(async () => ({
    name: "confirmed.json",
    async createWritable() {
      return {
        async write() {},
        async close() { closed = true; },
      };
    },
  }), async () => {
    const documentRef = createDocument();
    const controller = createController(documentRef);
    documentRef.elements.get("restart-tutorial").click();
    documentRef.elements.get("tutorial-restart-backup").click();
    await flush();

    assert.equal(closed, true);
    assert.equal(controller.restartBackupVerified, true);
    assert.equal(documentRef.elements.get("tutorial-restart-confirm").disabled, false);
  });
});

test("保存完了を確認できないブラウザではユーザー確認まで初期化を解禁しない", async () => {
  const hadOwn = Object.hasOwn(globalThis, "showSaveFilePicker");
  const previous = globalThis.showSaveFilePicker;
  delete globalThis.showSaveFilePicker;
  try {
    const documentRef = createDocument();
    const controller = createController(documentRef);
    documentRef.elements.get("restart-tutorial").click();
    documentRef.elements.get("tutorial-restart-backup").click();
    await flush();

    const manualConfirm = documentRef.elements.get("tutorial-restart-backup-confirm");
    assert.equal(controller.restartBackupVerified, false);
    assert.equal(documentRef.elements.get("tutorial-restart-confirm").disabled, true);
    assert.equal(manualConfirm.hidden, false);

    manualConfirm.click();
    assert.equal(controller.restartBackupVerified, true);
    assert.equal(documentRef.elements.get("tutorial-restart-confirm").disabled, false);
  } finally {
    if (hadOwn) globalThis.showSaveFilePicker = previous;
  }
});

test("閉じたダイアログの古い保存完了は再オープン後の初期化を解禁しない", async () => {
  let finishClose;
  const closeGate = new Promise((resolve) => { finishClose = resolve; });
  await withSavePicker(async () => ({
    name: "late.json",
    async createWritable() {
      return {
        async write() {},
        async close() { await closeGate; },
      };
    },
  }), async () => {
    const documentRef = createDocument();
    const controller = createController(documentRef);
    const open = documentRef.elements.get("restart-tutorial");
    const dialog = documentRef.elements.get("tutorial-restart-dialog");
    const save = documentRef.elements.get("tutorial-restart-backup");

    open.click();
    save.click();
    await flush();
    dialog.dispatch("pointerdown", { target: dialog });
    open.click();
    finishClose();
    await flush();

    assert.equal(controller.restartBackupVerified, false);
    assert.equal(documentRef.elements.get("tutorial-restart-confirm").disabled, true);
  });
});
