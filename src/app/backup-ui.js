import {
  createApplicationBackupFilename,
  downloadApplicationBackup,
  readApplicationBackupFile,
  writeApplicationBackupToFileHandle,
} from "./application-backup.js";

export class BackupUiController {
  constructor(documentRef = document, { app = null, modelProfileUi = null } = {}) {
    this.document = documentRef;
    this.app = app;
    this.modelProfileUi = modelProfileUi;
    this.restartBackupVerified = false;
    this.restartDialogGeneration = 0;
    this.elements = this.#resolveElements();
  }

  initialize() {
    this.elements.settingsExport.addEventListener("click", () => void this.#downloadBackup(this.elements.settingsStatus));
    this.elements.settingsImport.addEventListener("click", () => this.elements.settingsImportInput.click());
    this.elements.settingsImportInput.addEventListener("change", () => {
      const [file] = this.elements.settingsImportInput.files ?? [];
      if (file) void this.#restoreFile(file, this.elements.settingsStatus);
      this.elements.settingsImportInput.value = "";
    });

    this.elements.restart.addEventListener("click", () => this.#openRestartDialog());
    this.elements.restartCancel.addEventListener("click", () => this.#closeRestartDialog());
    this.elements.restartBackup.addEventListener("click", () => void this.#downloadRestartBackup());
    this.elements.restartBackupConfirm.addEventListener("click", () => this.#confirmRestartBackupSaved());
    this.elements.restartConfirm.addEventListener("click", () => void this.#confirmRestart());
    this.elements.restartDialog.addEventListener("pointerdown", (event) => {
      if (event.target === this.elements.restartDialog) this.#closeRestartDialog();
    });


    this.document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !this.elements.restartDialog.hidden) this.#closeRestartDialog();
    });
    return this;
  }

  async #downloadBackup(statusElement) {
    try {
      statusElement.textContent = "バックアップを作成しています。";
      const backup = await this.app.createBackup();
      const filename = downloadApplicationBackup(this.document, backup);
      statusElement.textContent = `${filename} のダウンロードを開始しました。音声モデルやモデルキャッシュ情報は含みません。`;
      return backup;
    } catch (error) {
      statusElement.textContent = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }

  async #restoreFile(file, statusElement) {
    try {
      statusElement.textContent = "バックアップを確認しています。";
      const backup = await readApplicationBackupFile(file);
      statusElement.textContent = "復元しています。完了するとページを再読み込みします。";
      await this.app.restoreBackup(backup);
    } catch (error) {
      statusElement.textContent = error instanceof Error ? error.message : String(error);
    }
  }

  #openRestartDialog() {
    this.restartDialogGeneration += 1;
    this.modelProfileUi?.closeSettings?.();
    this.restartBackupVerified = false;
    this.elements.restartBackup.disabled = false;
    this.elements.restartCancel.disabled = false;
    this.elements.restartConfirm.disabled = true;
    this.elements.restartBackupConfirm.hidden = true;
    this.elements.restartBackupConfirm.disabled = false;
    this.elements.restartStatus.textContent = "バックアップの保存を確認すると、初期化ボタンを押せるようになります。";
    this.elements.restartDialog.hidden = false;
    this.elements.restartBackup.focus({ preventScroll: true });
  }

  #closeRestartDialog() {
    this.restartDialogGeneration += 1;
    this.elements.restartDialog.hidden = true;
    this.restartBackupVerified = false;
    this.elements.restartConfirm.disabled = true;
    this.elements.restartBackupConfirm.hidden = true;
    this.elements.restart.focus({ preventScroll: true });
  }

  async #downloadRestartBackup() {
    const generation = this.restartDialogGeneration;
    this.restartBackupVerified = false;
    this.elements.restartConfirm.disabled = true;
    this.elements.restartBackupConfirm.hidden = true;
    this.elements.restartBackupConfirm.disabled = false;
    this.elements.restartBackup.disabled = true;
    try {
      if (typeof globalThis.showSaveFilePicker === "function") {
        let fileHandle;
        try {
          fileHandle = await globalThis.showSaveFilePicker({
            suggestedName: createApplicationBackupFilename(),
            types: [{
              description: "typed-voice バックアップ",
              accept: { "application/json": [".json"] },
            }],
          });
        } catch (error) {
          if (generation !== this.restartDialogGeneration) return;
          if (error?.name === "AbortError") {
            this.elements.restartStatus.textContent = "バックアップの保存をキャンセルしました。初期化はまだできません。";
            return;
          }
          throw error;
        }
        this.elements.restartStatus.textContent = "バックアップを作成して保存しています。";
        const backup = await this.app.createBackup();
        const filename = await writeApplicationBackupToFileHandle(fileHandle, backup);
        if (generation !== this.restartDialogGeneration) return;
        this.#markRestartBackupSaved(`${filename} を保存しました。初期化できるようになりました。`);
        return;
      }

      await this.#downloadBackup(this.elements.restartStatus);
      if (generation !== this.restartDialogGeneration) return;
      this.elements.restartBackupConfirm.hidden = false;
      this.elements.restartStatus.textContent = "ダウンロードを要求しました。このブラウザからは保存完了を確認できません。保存されたバックアップファイルを確認してください。";
      this.elements.restartBackupConfirm.focus({ preventScroll: true });
    } catch (error) {
      if (generation !== this.restartDialogGeneration) return;
      this.restartBackupVerified = false;
      this.elements.restartConfirm.disabled = true;
      this.elements.restartStatus.textContent = error instanceof Error ? error.message : String(error);
    } finally {
      if (generation === this.restartDialogGeneration) this.elements.restartBackup.disabled = false;
    }
  }

  #confirmRestartBackupSaved() {
    if (this.elements.restartBackupConfirm.hidden) return;
    this.elements.restartBackupConfirm.disabled = true;
    this.#markRestartBackupSaved("バックアップファイルの保存確認を受け付けました。初期化できるようになりました。");
  }

  #markRestartBackupSaved(message) {
    this.restartBackupVerified = true;
    this.elements.restartConfirm.disabled = false;
    this.elements.restartStatus.textContent = message;
    this.elements.restartConfirm.focus({ preventScroll: true });
  }

  async #confirmRestart() {
    if (!this.restartBackupVerified || this.elements.restartConfirm.disabled) return;
    this.elements.restartConfirm.disabled = true;
    this.elements.restartCancel.disabled = true;
    this.elements.restartBackup.disabled = true;
    this.elements.restartStatus.textContent = "会話・履歴・読み上げ待ち・設定・統計を初期化しています。音声モデルは残します。";
    try {
      await this.app.resetForTutorial();
    } catch (error) {
      this.elements.restartStatus.textContent = error instanceof Error ? error.message : String(error);
      this.elements.restartCancel.disabled = false;
      this.elements.restartBackup.disabled = false;
      this.elements.restartConfirm.disabled = !this.restartBackupVerified;
    }
  }

  #resolveElements() {
    const byId = (id) => {
      const element = this.document.getElementById(id);
      if (!element) throw new Error(`Required backup UI element is missing: ${id}`);
      return element;
    };
    return {
      settingsExport: byId("backup-export-button"),
      settingsImport: byId("backup-import-button"),
      settingsImportInput: byId("backup-import-input"),
      settingsStatus: byId("backup-settings-status"),
      restart: byId("restart-tutorial"),
      restartDialog: byId("tutorial-restart-dialog"),
      restartBackup: byId("tutorial-restart-backup"),
      restartBackupConfirm: byId("tutorial-restart-backup-confirm"),
      restartStatus: byId("tutorial-restart-status"),
      restartCancel: byId("tutorial-restart-cancel"),
      restartConfirm: byId("tutorial-restart-confirm"),
    };
  }
}

export function initializeBackupUi(documentRef = document, options = {}) {
  return new BackupUiController(documentRef, options).initialize();
}
