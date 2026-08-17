import {
  downloadApplicationBackup,
  readApplicationBackupFile,
} from "./application-backup.js";

export class BackupUiController {
  constructor(documentRef = document, { app = null, modelProfileUi = null } = {}) {
    this.document = documentRef;
    this.app = app;
    this.modelProfileUi = modelProfileUi;
    this.restartBackupDownloaded = false;
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
    this.modelProfileUi?.closeSettings?.();
    this.restartBackupDownloaded = false;
    this.elements.restartConfirm.disabled = true;
    this.elements.restartStatus.textContent = "バックアップをダウンロードすると、初期化ボタンを押せるようになります。";
    this.elements.restartDialog.hidden = false;
    this.elements.restartBackup.focus({ preventScroll: true });
  }

  #closeRestartDialog() {
    this.elements.restartDialog.hidden = true;
    this.restartBackupDownloaded = false;
    this.elements.restartConfirm.disabled = true;
    this.elements.restart.focus({ preventScroll: true });
  }

  async #downloadRestartBackup() {
    try {
      await this.#downloadBackup(this.elements.restartStatus);
      this.restartBackupDownloaded = true;
      this.elements.restartConfirm.disabled = false;
      this.elements.restartStatus.textContent = "バックアップのダウンロードを開始しました。これで初期化してやり直せます。";
      this.elements.restartConfirm.focus({ preventScroll: true });
    } catch {
      this.restartBackupDownloaded = false;
      this.elements.restartConfirm.disabled = true;
    }
  }

  async #confirmRestart() {
    if (!this.restartBackupDownloaded || this.elements.restartConfirm.disabled) return;
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
      this.elements.restartConfirm.disabled = !this.restartBackupDownloaded;
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
      restartStatus: byId("tutorial-restart-status"),
      restartCancel: byId("tutorial-restart-cancel"),
      restartConfirm: byId("tutorial-restart-confirm"),
    };
  }
}

export function initializeBackupUi(documentRef = document, options = {}) {
  return new BackupUiController(documentRef, options).initialize();
}
