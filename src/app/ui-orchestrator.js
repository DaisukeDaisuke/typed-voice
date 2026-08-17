import { IndexedDbConversationRepository, openConversationDatabase } from "./storage.js";
import { UtteranceOrchestrator } from "./utterance-orchestrator.js";
import {
  getCompletedLineFromLineBreak,
  retainRecentSubmittedLines,
} from "./composer-policy.js";
import { planComposerRevisions } from "./revision-target.js";
import { prepareKanalizerOffline } from "../text/kanalizer-normalizer.js";
import {
  createConversationFromSubmittedText,
  normalizeConversationId,
  resolveCurrentConversation,
  selectBootstrapConversationId,
} from "./conversation-session-policy.js";
import {
  clearAllApplicationData,
  clearConversationData,
  createApplicationBackup,
  restoreApplicationBackup,
} from "./application-backup.js";

const DEFAULT_REASONING_SECONDS = 2;
const CONVERSATION_PARAM = "conversation";
const RESTORED_UI_SESSION_KEY = "typed-voice-restored-ui-v1";
const BOOTSTRAP_SESSION_KEY = "typed-voice-bootstrap-conversation-v1";
const BOOTSTRAP_SESSION_MAX_AGE_MS = 10_000;

function formatTime(timestamp) {
  return new Intl.DateTimeFormat("ja-JP", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(timestamp));
}

function formatNumber(value) {
  return new Intl.NumberFormat("ja-JP").format(Number(value || 0));
}


function isInteractiveTarget(target) {
  return Boolean(target.closest("button, a, input, textarea, select, label"));
}

export class UiOrchestrator {
  constructor(documentRef = document, { voiceRuntime = null, getModelProfile = () => "fp16" } = {}) {
    this.document = documentRef;
    this.voiceRuntime = voiceRuntime;
    this.getModelProfile = getModelProfile;
    this.repository = null;
    this.utterances = null;
    this.currentSession = null;
    this.channel = "BroadcastChannel" in globalThis ? new BroadcastChannel("typed-voice-conversations") : null;
    this.typingStartedAt = null;
    this.deletedChars = 0;
    this.pendingTicker = null;
    this.ensureConversationPromise = null;
    this.secondaryView = "timeline";
    this.elements = this.#resolveElements();
  }

  async initialize() {
    const db = await openConversationDatabase();
    this.repository = new IndexedDbConversationRepository(db);
    this.utterances = new UtteranceOrchestrator({
      repository: this.repository,
      speech: this.voiceRuntime,
      playback: this.voiceRuntime,
      onChange: () => void this.refreshAll(),
    });
    this.#bindEvents();

    const storedWait = Number(await this.repository.getSetting("reasoningSeconds", DEFAULT_REASONING_SECONDS));
    this.elements.reasoningSeconds.value = Number.isFinite(storedWait) ? String(storedWait) : String(DEFAULT_REASONING_SECONDS);
    const storedSpeed = Number(await this.repository.getSetting("speechSpeed", 1));
    const speed = Number.isFinite(storedSpeed) ? Math.min(2, Math.max(0.5, storedSpeed)) : 1;
    this.elements.speechSpeed.value = String(speed);
    this.voiceRuntime?.setSpeed(speed);

    const requestedId = normalizeConversationId(new URL(location.href).searchParams.get(CONVERSATION_PARAM));
    const session = requestedId ? await this.repository.getSession(requestedId) : null;
    if (session) {
      await this.openConversation(session.id, { replaceUrl: true });
    } else {
      const navigationType = performance.getEntriesByType("navigation")[0]?.type ?? "navigate";
      const storedBootstrap = this.#readBootstrapSession();
      const bootstrapId = selectBootstrapConversationId({
        requestedId,
        reloadId: storedBootstrap?.id,
        navigationType,
      });
      this.#writeBootstrapSession(bootstrapId);
      this.#writeUrl(bootstrapId, true);
      await this.ensureCurrentConversation({ replaceUrl: true, preferredId: bootstrapId });
      await this.refreshAll();
      this.#showSecondaryView("timeline");
      this.focusComposer();
    }
    this.#restoreUiStateAfterImport();

    this.channel?.addEventListener("message", () => void this.refreshAll());
    window.addEventListener("popstate", () => void this.#openFromUrl());
    this.pendingTicker = setInterval(() => this.#updatePendingTimers(), 250);
    this.elements.status.textContent = "入力できます。音声の受入試験は「音声テスト」からいつでも開けます。";
    this.focusComposer();
  }

  async createConversation({ replaceUrl = false } = {}) {
    const session = await this.repository.createSession();
    await this.openConversation(session.id, { replaceUrl });
    this.#broadcast();
    return session;
  }

  getBackupUiState() {
    return {
      currentSessionId: this.currentSession?.id ?? null,
      composerValue: this.elements.composer.value,
      composerSelectionStart: this.elements.composer.selectionStart,
      composerSelectionEnd: this.elements.composer.selectionEnd,
      secondaryView: this.secondaryView,
    };
  }

  async createBackup() {
    return createApplicationBackup({
      db: this.repository?.db,
      storage: globalThis.localStorage,
      uiState: this.getBackupUiState(),
    });
  }

  async restoreBackup(backup) {
    await this.#cancelAllPendingJobs();
    await restoreApplicationBackup({ db: this.repository?.db, storage: globalThis.localStorage }, backup);
    if (backup.uiState) sessionStorage.setItem(RESTORED_UI_SESSION_KEY, JSON.stringify(backup.uiState));
    const url = new URL(location.href);
    if (backup.uiState?.currentSessionId) url.searchParams.set(CONVERSATION_PARAM, backup.uiState.currentSessionId);
    else url.searchParams.delete(CONVERSATION_PARAM);
    history.replaceState(null, "", url);
    location.reload();
  }

  async resetForTutorial() {
    await this.#cancelAllPendingJobs();
    await clearAllApplicationData({ db: this.repository?.db, storage: globalThis.localStorage });
    sessionStorage.removeItem(RESTORED_UI_SESSION_KEY);
    const url = new URL(location.href);
    url.searchParams.delete(CONVERSATION_PARAM);
    location.replace(url);
  }

  async finishTutorialData() {
    await this.#cancelAllPendingJobs();
    await clearConversationData(this.repository?.db);
    this.currentSession = null;
    this.elements.composer.value = "";
    this.elements.composer.setSelectionRange(0, 0);
    await this.ensureCurrentConversation({ replaceUrl: true });
    await this.refreshAll();
    this.#showSecondaryView("timeline");
    this.focusComposer();
  }

  async startConversationFromSubmittedText(text) {
    const session = await createConversationFromSubmittedText(this.repository, text);
    this.currentSession = session;
    this.#writeUrl(session.id, false);
    this.#showSecondaryView("timeline");
    this.#broadcast();
    return session;
  }

  async ensureCurrentConversation({ replaceUrl = true, preferredId = null } = {}) {
    if (this.ensureConversationPromise) return this.ensureConversationPromise;
    const currentSession = this.currentSession;
    this.ensureConversationPromise = (async () => {
      const session = await resolveCurrentConversation(this.repository, currentSession, { preferredId });
      const changed = !currentSession || currentSession.id !== session.id;
      this.currentSession = session;
      if (changed) {
        this.#writeUrl(session.id, replaceUrl);
        this.#broadcast();
      }
      return session;
    })();
    try {
      return await this.ensureConversationPromise;
    } finally {
      this.ensureConversationPromise = null;
    }
  }

  async openConversation(id, { replaceUrl = false } = {}) {
    const session = await this.repository.getSession(id);
    if (!session) return this.createConversation({ replaceUrl: true });
    this.currentSession = session;
    this.#writeUrl(session.id, replaceUrl);
    await Promise.all([
      this.refreshCurrentConversation(),
      this.refreshConversationList(),
      this.refreshStatistics(),
    ]);
    this.#showSecondaryView("timeline");
    this.focusComposer();
  }

  async submitComposer() {
    const composer = this.elements.composer;
    const line = getComposerLineAtCaret(composer.value, composer.selectionStart);
    if (!line.trim()) return;
    if (this.secondaryView !== "conversations") {
      const session = await this.ensureCurrentConversation();
      const allPending = await this.repository.listPending(session.id);
      if (allPending.some((item) => item.text.trim() === line.trim())) {
        throw new Error("この行はすでに読み上げ待ちです。訂正する場合は上の訂正ボタンを使ってください。");
      }
    }
    const lineEnd = composer.value.indexOf("\n", composer.selectionStart);
    const insertAt = lineEnd === -1 ? composer.value.length : lineEnd;
    composer.setRangeText("\n", insertAt, insertAt, "end");
    await this.#finalizeComposerLineBreak();
  }

  focusComposer() {
    this.elements.composer.focus({ preventScroll: true });
  }

  async enableVoice() {
    if (!this.voiceRuntime) throw new Error("音声エンジンを利用できません。");
    if (this.voiceRuntime.ready && this.voiceRuntime.audioEnabled) return { ready: true };
    this.elements.voiceEnable.disabled = true;
    try {
      const initialized = await this.voiceRuntime.enable(this.getModelProfile());
      this.elements.voiceEnable.textContent = "音声 有効";
      return initialized;
    } finally {
      if (!this.voiceRuntime.ready) this.elements.voiceEnable.disabled = false;
    }
  }

  getReasoningSeconds() {
    const value = Number(this.elements.reasoningSeconds.value);
    return Number.isFinite(value) ? Math.min(30, Math.max(0, value)) : DEFAULT_REASONING_SECONDS;
  }

  async setReasoningSeconds(value) {
    const normalized = Number.isFinite(Number(value))
      ? Math.min(30, Math.max(0, Number(value)))
      : DEFAULT_REASONING_SECONDS;
    this.elements.reasoningSeconds.value = String(normalized);
    await this.repository?.setSetting("reasoningSeconds", normalized);
    return normalized;
  }

  get voiceRuntimeState() {
    return {
      ready: Boolean(this.voiceRuntime?.ready),
      prepared: Boolean(this.voiceRuntime?.prepared),
      profile: this.voiceRuntime?.activeProfile ?? null,
    };
  }

  async getVoiceProfilePlan(profile = this.getModelProfile()) {
    if (!this.voiceRuntime?.getProfilePlan) throw new Error("音声モデル情報を取得できません。");
    return this.voiceRuntime.getProfilePlan(profile);
  }

  async prepareOfflineVoice(profile = this.getModelProfile(), { onKanalizerStatus = () => {}, signal = null } = {}) {
    if (!this.voiceRuntime?.prepare) throw new Error("音声データを準備できません。");
    const voice = await this.voiceRuntime.prepare(profile, { signal });
    const kanalizer = await prepareKanalizerOffline({ onStatus: onKanalizerStatus, signal });
    return {
      profile,
      voice,
      kanalizer,
      totalBytes: Number(voice?.totalBytes || 0)
        + Number(kanalizer?.modelBytes || 0)
        + Number(kanalizer?.dictionaryBytes || 0)
        + Number(kanalizer?.wasmBytes || 0),
    };
  }

  async initializePreparedVoice(profile = this.getModelProfile(), { enableAudio = true } = {}) {
    if (!this.voiceRuntime?.initializePrepared) throw new Error("保存済み音声モデルを読み込めません。");
    if (this.voiceRuntime.ready && (!enableAudio || this.voiceRuntime.audioEnabled)) return { ready: true };
    const panel = this.elements.voiceLoadProgress;
    const progress = this.elements.voiceLoadProgressBar;
    const status = this.elements.voiceLoadStatus;
    const detail = this.elements.voiceLoadDetail;
    panel.hidden = false;
    progress.value = 0;
    status.textContent = "保存済みモデルを読み込んでいます。";
    detail.textContent = "キャッシュを確認中…";
    const unsubscribe = this.voiceRuntime.subscribeProgress((message) => {
      if (message.stage !== "initialize") return;
      const loaded = Number(message.loadedBytes || 0);
      const total = Number(message.totalBytes || 0);
      if (total > 0) {
        const percent = Math.max(0, Math.min(100, loaded / total * 100));
        progress.value = percent;
        detail.textContent = `${percent.toFixed(1)}% · ${(loaded / 1024 / 1024).toFixed(1)} / ${(total / 1024 / 1024).toFixed(1)} MiB`;
      } else if (message.phase) {
        detail.textContent = message.backend ? `${message.phase} · ${message.backend}` : message.phase;
      }
    });
    try {
      const initialized = await this.voiceRuntime.initializePrepared(profile, { enableAudio });
      progress.value = 100;
      status.textContent = "音声モデルを読み込みました。";
      detail.textContent = initialized?.backend ? `backend: ${initialized.backend}` : "準備完了";
      this.elements.voiceEnable.textContent = enableAudio ? "音声 有効" : "音声を有効化";
      this.elements.voiceEnable.disabled = false;
      globalThis.setTimeout(() => {
        if (status.textContent === "音声モデルを読み込みました。") panel.hidden = true;
      }, 1600);
      return initialized;
    } catch (error) {
      status.textContent = "音声モデルの読み込みに失敗しました。";
      detail.textContent = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      unsubscribe?.();
    }
  }

  get currentPendingCount() {
    return [...(this.utterances?.jobs.values() ?? [])]
      .filter((job) => job.sessionId === this.currentSession?.id).length;
  }

  get latestPendingText() {
    return [...(this.utterances?.jobs.values() ?? [])]
      .filter((job) => job.sessionId === this.currentSession?.id)
      .sort((left, right) => right.createdAt - left.createdAt)[0]?.text ?? null;
  }

  async cancelLatestPending({ refresh = "all" } = {}) {
    const jobs = [...(this.utterances?.jobs.values() ?? [])]
      .filter((job) => job.sessionId === this.currentSession?.id)
      .sort((left, right) => right.createdAt - left.createdAt);
    const latest = jobs[0];
    if (!latest) return false;
    const cancelled = await this.utterances.cancel(latest.id);
    if (refresh === "pending") {
      const pending = await this.repository.listPending(this.currentSession.id);
      this.#renderPending(pending);
    } else if (refresh !== "none") {
      await this.refreshAll();
    }
    return cancelled;
  }

  async applyCorrectionFromComposer() {
    const session = await this.ensureCurrentConversation();
    const text = this.elements.composer.value;
    if (!text.trim()) throw new Error("訂正する文章を入力してください。");
    const pending = await this.repository.listPending(session.id);
    const revisions = planComposerRevisions(
      text,
      pending,
      (id) => this.utterances.isRevisionable(id)
    );
    if (revisions.length === 0) throw new Error("訂正差分がありません。");
    for (const revision of revisions) {
      await this.utterances.beginEdit(revision.pending.id);
      await this.utterances.edit(revision.pending.id, revision.text, this.#reasoningSeconds());
    }
    this.elements.status.textContent = `${revisions.length}件の読み上げ待ちを訂正しました。`;
    await this.refreshAll();
    this.#broadcast();
    this.focusComposer();
  }

  async forceQueueHead() {
    const session = await this.ensureCurrentConversation();
    const pending = await this.repository.listPending(session.id);
    const target = [...pending]
      .filter((item) => this.utterances.jobs.has(item.id))
      .sort((left, right) => left.createdAt - right.createdAt)[0];
    if (!target) throw new Error("今すぐ読み上げできる文章がありません。");
    await this.utterances.forceReady(target.id);
    this.elements.status.textContent = "読み上げ待ち時間を終了しました。";
    await this.refreshAll();
  }

  async cancelCurrentPending() {
    const session = await this.ensureCurrentConversation();
    const pending = await this.repository.listPending(session.id);
    const target = [...pending].sort((left, right) => right.createdAt - left.createdAt)[0];
    if (!target) throw new Error("取り消せる読み上げ待ちがありません。");
    await this.utterances.cancel(target.id);
    this.elements.status.textContent = "読み上げ待ちを取り消しました。";
    await this.refreshAll();
    this.#broadcast();
    this.focusComposer();
  }

  async refreshAll() {
    await this.ensureCurrentConversation();
    await Promise.all([
      this.refreshCurrentConversation(),
      this.refreshConversationList(),
      this.refreshStatistics(),
    ]);
  }

  async refreshCurrentConversation() {
    const session = await this.ensureCurrentConversation();
    this.currentSession = session;
    const [messages, pending] = await Promise.all([
      this.repository.listMessages(session.id),
      this.repository.listPending(session.id),
    ]);
    for (const item of pending) {
      await this.utterances.resume(item);
    }
    this.#renderMessages(messages);
    this.#renderPending(pending);
    this.elements.conversationTitle.textContent = this.currentSession.firstMessagePreview || "新しい会話";

  }

  async refreshConversationList() {
    const sessions = await this.repository.listSessions(100);
    const fragment = document.createDocumentFragment();
    for (const session of sessions) {
      const node = this.elements.conversationTemplate.content.firstElementChild.cloneNode(true);
      node.dataset.sessionId = session.id;
      node.setAttribute("aria-current", session.id === this.currentSession?.id ? "true" : "false");
      node.querySelector(".conversation-preview").textContent = session.firstMessagePreview || "新しい会話";
      node.querySelector(".conversation-meta").textContent = `${formatTime(session.updatedAt)} · ${session.messageCount}件`;
      node.addEventListener("click", () => void this.openConversation(session.id));
      fragment.append(node);
    }
    this.elements.conversationList.replaceChildren(fragment);
  }

  async refreshStatistics() {
    const statistics = await this.repository.getStatistics();
    this.elements.statMessages.textContent = formatNumber(statistics.messageCount);
    this.elements.statConversations.textContent = formatNumber(statistics.conversationCount);
    this.elements.statTyped.textContent = formatNumber(statistics.typedChars);
    this.elements.statDays.textContent = formatNumber(statistics.activeDays);
  }

  #renderMessages(messages) {
    const fragment = document.createDocumentFragment();
    for (const message of [...messages].reverse()) {
      const node = this.elements.messageTemplate.content.firstElementChild.cloneNode(true);
      node.querySelector(".message-text").textContent = message.text;
      const time = node.querySelector(".message-time");
      time.dateTime = new Date(message.createdAt).toISOString();
      time.textContent = formatTime(message.createdAt);
      fragment.append(node);
    }
    this.elements.messageList.replaceChildren(fragment);
    this.elements.emptyTimeline.hidden = messages.length > 0;
  }

  #renderPending(pending) {
    const fragment = document.createDocumentFragment();
    for (const item of pending) {
      const node = this.elements.pendingTemplate.content.firstElementChild.cloneNode(true);
      node.dataset.pendingId = item.id;
      const cancel = node.querySelector(".pending-cancel");
      const error = node.querySelector(".pending-error");
      node.querySelector(".pending-text").textContent = item.text;
      if (item.error) {
        error.hidden = false;
        error.textContent = item.error;
      }
      cancel.addEventListener("click", async () => {
        await this.utterances.cancel(item.id);
        await this.refreshAll();
        this.#broadcast();
        this.focusComposer();
      });
      fragment.append(node);
    }
    this.elements.pendingList.replaceChildren(fragment);
    this.elements.pendingCount.textContent = String(pending.length);
    const hasRevisionable = pending.some((item) => this.utterances.isRevisionable(item.id));
    this.elements.correctionButton.disabled = !hasRevisionable;
    this.elements.cancelCurrentButton.disabled = pending.length === 0;
    this.elements.forceSpeakButton.disabled = pending.length === 0;
    this.#updatePendingTimers();
  }

  #updatePendingTimers() {
    const currentTime = Date.now();
    for (const node of this.elements.pendingList.querySelectorAll(".pending-card")) {
      const job = this.utterances.jobs.get(node.dataset.pendingId);
      if (!job) continue;
      const remaining = Math.max(0, job.reasoningDeadline - currentTime) / 1000;
      node.querySelector(".pending-timer").textContent = remaining > 0
        ? `あと ${remaining.toFixed(1)} 秒で読み上げ`
        : "読み上げを開始します";
      if (job.state === "editing") {
        node.querySelector(".pending-state").textContent = "訂正中";
        node.querySelector(".pending-timer").textContent = "入力待ち";
      } else {
        const state = node.querySelector(".pending-state");
        if (job.state === "voice-error") {
          state.textContent = "音声エラー";
        } else {
          state.replaceChildren();
          const dot = document.createElement("i");
          dot.className = "pending-dot";
          dot.setAttribute("aria-hidden", "true");
          state.append(dot, document.createTextNode("送信済み"));
        }
      }
    }
  }

  #bindEvents() {
    this.elements.submitButton.addEventListener("click", () => void this.#runUiTask(() => this.submitComposer()));
    this.elements.correctionButton.addEventListener("click", () => void this.#runUiTask(() => this.applyCorrectionFromComposer()));
    this.elements.cancelCurrentButton.addEventListener("click", () => void this.#runUiTask(() => this.cancelCurrentPending()));
    this.elements.forceSpeakButton.addEventListener("click", () => void this.#runUiTask(() => this.forceQueueHead()));
    this.elements.newConversation.addEventListener("click", () => void this.#runUiTask(() => this.createConversation()));
    this.elements.focusComposer.addEventListener("click", () => this.focusComposer());
    this.elements.timelineView.addEventListener("click", () => this.#showSecondaryView("timeline"));
    this.elements.conversationView.addEventListener("click", () => this.#showSecondaryView("conversations"));
    this.elements.reasoningSeconds.addEventListener("change", () => {
      void this.setReasoningSeconds(this.elements.reasoningSeconds.value);
    });
    this.elements.speechSpeed.addEventListener("change", () => {
      try {
        const value = Number(this.elements.speechSpeed.value);
        this.voiceRuntime?.setSpeed(value);
        void this.repository.setSetting("speechSpeed", value);
      } catch (error) {
        this.elements.status.textContent = error instanceof Error ? error.message : String(error);
      }
    });
    this.elements.voiceEnable.addEventListener("click", () => void this.#runUiTask(() => this.enableVoice()));

    this.elements.composer.addEventListener("beforeinput", (event) => {
      if (this.typingStartedAt == null) this.typingStartedAt = performance.now();
      if (event.inputType?.startsWith("delete")) this.deletedChars += 1;
    });
    this.elements.composer.addEventListener("input", (event) => {
      if (event.inputType === "insertLineBreak" || event.inputType === "insertParagraph") {
        void this.#runUiTask(() => this.#finalizeComposerLineBreak());
      }
    });
    this.elements.composerPanel.addEventListener("click", (event) => {
      if (!isInteractiveTarget(event.target)) this.focusComposer();
    });
  }

  async #runUiTask(task) {
    try {
      await task();
      this.elements.status.textContent = "入力できます。";
    } catch (error) {
      this.elements.status.textContent = error instanceof Error ? error.message : String(error);
    }
  }

  #reasoningSeconds() {
    return this.getReasoningSeconds();
  }

  async #finalizeComposerLineBreak() {
    const composer = this.elements.composer;
    const completed = getCompletedLineFromLineBreak(composer.value, composer.selectionStart);
    if (!completed.trim()) return;
    const session = this.secondaryView === "conversations"
      ? await this.startConversationFromSubmittedText(completed)
      : await this.ensureCurrentConversation();
    const typingMs = this.typingStartedAt == null ? 0 : Math.max(0, performance.now() - this.typingStartedAt);
    await this.repository.recordInputStatistics({
      typedChars: completed.length,
      deletedChars: this.deletedChars,
      typingMs,
      sessionId: session.id,
    });
    const pending = await this.utterances.submit({
      sessionId: session.id,
      text: completed,
      reasoningSeconds: this.#reasoningSeconds(),
    });
    const retained = retainRecentSubmittedLines(composer.value, composer.selectionStart, 2);
    if (retained.value !== composer.value || retained.caret !== composer.selectionStart) {
      composer.value = retained.value;
      composer.setSelectionRange(retained.caret, retained.caret);
    }
    this.typingStartedAt = null;
    this.deletedChars = 0;
    await this.refreshAll();
    this.#broadcast();
    this.focusComposer();
  }

  #showSecondaryView(view) {
    const showTimeline = view === "timeline";
    this.secondaryView = showTimeline ? "timeline" : "conversations";
    this.elements.timelinePanel.hidden = !showTimeline;
    this.elements.conversationPanel.hidden = showTimeline;
    this.elements.timelineView.setAttribute("aria-pressed", String(showTimeline));
    this.elements.conversationView.setAttribute("aria-pressed", String(!showTimeline));
  }

  #writeUrl(sessionId, replace) {
    const url = new URL(location.href);
    url.searchParams.set(CONVERSATION_PARAM, sessionId);
    history[replace ? "replaceState" : "pushState"]({ sessionId }, "", url);
  }

  async #cancelAllPendingJobs() {
    for (const id of [...(this.utterances?.jobs.keys() ?? [])]) {
      await this.utterances.cancel(id).catch(() => false);
    }
  }

  #restoreUiStateAfterImport() {
    let restored = null;
    try {
      const raw = sessionStorage.getItem(RESTORED_UI_SESSION_KEY);
      sessionStorage.removeItem(RESTORED_UI_SESSION_KEY);
      if (raw) restored = JSON.parse(raw);
    } catch {
      sessionStorage.removeItem(RESTORED_UI_SESSION_KEY);
    }
    if (!restored) return;
    const composerValue = typeof restored.composerValue === "string" ? restored.composerValue : "";
    this.elements.composer.value = composerValue;
    const start = Math.max(0, Math.min(composerValue.length, Number(restored.composerSelectionStart) || 0));
    const end = Math.max(start, Math.min(composerValue.length, Number(restored.composerSelectionEnd) || start));
    this.elements.composer.setSelectionRange(start, end);
    this.#showSecondaryView(restored.secondaryView === "conversations" ? "conversations" : "timeline");
  }

  #readBootstrapSession() {
    try {
      const raw = sessionStorage.getItem(BOOTSTRAP_SESSION_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      const id = normalizeConversationId(parsed?.id);
      const createdAt = Number(parsed?.createdAt);
      if (!id || !Number.isFinite(createdAt) || Date.now() - createdAt > BOOTSTRAP_SESSION_MAX_AGE_MS) {
        sessionStorage.removeItem(BOOTSTRAP_SESSION_KEY);
        return null;
      }
      return { id, createdAt };
    } catch {
      sessionStorage.removeItem(BOOTSTRAP_SESSION_KEY);
      return null;
    }
  }

  #writeBootstrapSession(id) {
    try {
      sessionStorage.setItem(BOOTSTRAP_SESSION_KEY, JSON.stringify({ id, createdAt: Date.now() }));
    } catch {
      // The URL still remains the primary durable bootstrap identifier.
    }
  }

  async #openFromUrl() {
    const id = new URL(location.href).searchParams.get(CONVERSATION_PARAM);
    if (id === this.currentSession?.id) {
      await this.ensureCurrentConversation({ replaceUrl: true });
      return;
    }
    if (id && await this.repository.getSession(id)) {
      await this.openConversation(id, { replaceUrl: true });
      return;
    }
    await this.createConversation({ replaceUrl: true });
  }

  #broadcast() {
    this.channel?.postMessage({ type: "changed", sessionId: this.currentSession?.id, at: Date.now() });
  }

  #resolveElements() {
    const byId = (id) => {
      const element = this.document.getElementById(id);
      if (!element) throw new Error(`Required UI element is missing: ${id}`);
      return element;
    };
    return {
      composerPanel: byId("composer-panel"),
      composer: byId("composer"),
      reasoningSeconds: byId("reasoning-seconds"),
      speechSpeed: byId("speech-speed"),
      submitButton: byId("submit-button"),
      voiceEnable: byId("voice-enable"),
      voiceLoadProgress: byId("voice-load-progress"),
      voiceLoadProgressBar: byId("voice-load-progress-bar"),
      voiceLoadStatus: byId("voice-load-status"),
      voiceLoadDetail: byId("voice-load-detail"),
      focusComposer: byId("focus-composer"),
      status: byId("app-status"),
      conversationTitle: byId("conversation-title"),

      pendingList: byId("pending-list"),
      pendingCount: byId("pending-count"),
      messageList: byId("message-list"),
      emptyTimeline: byId("empty-timeline"),
      conversationList: byId("conversation-list"),
      timelinePanel: byId("timeline-panel"),
      conversationPanel: byId("conversation-panel"),
      timelineView: byId("timeline-view"),
      conversationView: byId("conversation-view"),
      newConversation: byId("new-conversation"),
      correctionButton: byId("correction-button"),
      cancelCurrentButton: byId("cancel-current-button"),
      forceSpeakButton: byId("force-speak-button"),
      statMessages: byId("stat-messages"),
      statConversations: byId("stat-conversations"),
      statTyped: byId("stat-typed"),
      statDays: byId("stat-days"),
      conversationTemplate: byId("conversation-template"),
      messageTemplate: byId("message-template"),
      pendingTemplate: byId("pending-template"),
    };
  }
}
