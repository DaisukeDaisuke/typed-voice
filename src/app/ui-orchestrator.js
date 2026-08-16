import { IndexedDbConversationRepository, openConversationDatabase } from "./storage.js";
import { UtteranceOrchestrator } from "./utterance-orchestrator.js";
import {
  getCompletedLineFromLineBreak,
  retainRecentSubmittedLines,
} from "./composer-policy.js";
import { planComposerRevisions } from "./revision-target.js";

const DEFAULT_REASONING_SECONDS = 2;
const CONVERSATION_PARAM = "conversation";

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
  constructor(documentRef = document, { voiceRuntime = null } = {}) {
    this.document = documentRef;
    this.voiceRuntime = voiceRuntime;
    this.repository = null;
    this.utterances = null;
    this.currentSession = null;
    this.channel = "BroadcastChannel" in globalThis ? new BroadcastChannel("typed-voice-conversations") : null;
    this.typingStartedAt = null;
    this.deletedChars = 0;
    this.pendingTicker = null;
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

    const requestedId = new URL(location.href).searchParams.get(CONVERSATION_PARAM);
    const session = requestedId ? await this.repository.getSession(requestedId) : null;
    if (session) {
      await this.openConversation(session.id, { replaceUrl: true });
    } else {
      await this.createConversation({ replaceUrl: true });
    }

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
    if (!this.currentSession) return;
    const composer = this.elements.composer;
    const line = getComposerLineAtCaret(composer.value, composer.selectionStart);
    if (!line.trim()) return;
    const pending = await this.repository.listPending(this.currentSession.id);
    if (pending.some((item) => item.text.trim() === line.trim())) {
      throw new Error("この行はすでに読み上げ待ちです。訂正する場合は上の訂正ボタンを使ってください。");
    }
    const lineEnd = composer.value.indexOf("\n", composer.selectionStart);
    const insertAt = lineEnd === -1 ? composer.value.length : lineEnd;
    composer.setRangeText("\n", insertAt, insertAt, "end");
    await this.#finalizeComposerLineBreak();
  }

  focusComposer() {
    this.elements.composer.focus({ preventScroll: true });
  }

  async applyCorrectionFromComposer() {
    if (!this.currentSession) return;
    const text = this.elements.composer.value;
    if (!text.trim()) throw new Error("訂正する文章を入力してください。");
    const pending = await this.repository.listPending(this.currentSession.id);
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
    if (!this.currentSession) return;
    const pending = await this.repository.listPending(this.currentSession.id);
    const target = [...pending]
      .filter((item) => this.utterances.jobs.has(item.id))
      .sort((left, right) => left.createdAt - right.createdAt)[0];
    if (!target) throw new Error("今すぐ読み上げできる文章がありません。");
    await this.utterances.forceReady(target.id);
    this.elements.status.textContent = "読み上げ待ち時間を終了しました。";
    await this.refreshAll();
  }

  async cancelCurrentPending() {
    if (!this.currentSession) return;
    const pending = await this.repository.listPending(this.currentSession.id);
    const target = [...pending].sort((left, right) => right.createdAt - left.createdAt)[0];
    if (!target) throw new Error("取り消せる読み上げ待ちがありません。");
    await this.utterances.cancel(target.id);
    this.elements.status.textContent = "読み上げ待ちを取り消しました。";
    await this.refreshAll();
    this.#broadcast();
    this.focusComposer();
  }

  async refreshAll() {
    await Promise.all([
      this.refreshCurrentConversation(),
      this.refreshConversationList(),
      this.refreshStatistics(),
    ]);
  }

  async refreshCurrentConversation() {
    if (!this.currentSession) return;
    this.currentSession = await this.repository.getSession(this.currentSession.id) ?? this.currentSession;
    const [messages, pending] = await Promise.all([
      this.repository.listMessages(this.currentSession.id),
      this.repository.listPending(this.currentSession.id),
    ]);
    for (const item of pending) await this.utterances.resume(item);
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
    for (const message of messages) {
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
      node.querySelector(".pending-timer").textContent = remaining > 0 ? `${remaining.toFixed(1)}秒` : "確定待ち";
      if (job.state === "editing") {
        node.querySelector(".pending-state").textContent = "訂正中";
        node.querySelector(".pending-timer").textContent = "入力待ち";
      } else {
        node.querySelector(".pending-state").textContent = job.state === "voice-error" ? "音声エラー" : "読み上げ待ち";
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
      const value = this.#reasoningSeconds();
      this.elements.reasoningSeconds.value = String(value);
      void this.repository.setSetting("reasoningSeconds", value);
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
    this.elements.voiceEnable.addEventListener("click", () => void this.#runUiTask(async () => {
      if (!this.voiceRuntime) throw new Error("音声エンジンを利用できません。");
      this.elements.voiceEnable.disabled = true;
      try {
        await this.voiceRuntime.enable();
        this.elements.voiceEnable.textContent = "音声 有効";
      } finally {
        if (!this.voiceRuntime.ready) this.elements.voiceEnable.disabled = false;
      }
    }));

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
    const value = Number(this.elements.reasoningSeconds.value);
    return Number.isFinite(value) ? Math.min(30, Math.max(0, value)) : DEFAULT_REASONING_SECONDS;
  }

  async #finalizeComposerLineBreak() {
    if (!this.currentSession) return;
    const composer = this.elements.composer;
    const completed = getCompletedLineFromLineBreak(composer.value, composer.selectionStart);
    if (!completed.trim()) return;
    const typingMs = this.typingStartedAt == null ? 0 : Math.max(0, performance.now() - this.typingStartedAt);
    await this.repository.recordInputStatistics({
      typedChars: completed.length,
      deletedChars: this.deletedChars,
      typingMs,
    });
    await this.utterances.submit({
      sessionId: this.currentSession.id,
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

  async #openFromUrl() {
    const id = new URL(location.href).searchParams.get(CONVERSATION_PARAM);
    if (id && id !== this.currentSession?.id && await this.repository.getSession(id)) {
      await this.openConversation(id, { replaceUrl: true });
    }
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
