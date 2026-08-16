import { IndexedDbConversationRepository, openConversationDatabase } from "./storage.js";
import { UtteranceOrchestrator } from "./utterance-orchestrator.js";

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
  constructor(documentRef = document) {
    this.document = documentRef;
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
      onChange: () => void this.refreshAll(),
    });
    this.#bindEvents();

    const storedWait = Number(await this.repository.getSetting("reasoningSeconds", DEFAULT_REASONING_SECONDS));
    this.elements.reasoningSeconds.value = Number.isFinite(storedWait) ? String(storedWait) : String(DEFAULT_REASONING_SECONDS);

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
    this.elements.historyPanel.classList.remove("open");
    this.elements.historyToggle.setAttribute("aria-expanded", "false");
    this.focusComposer();
  }

  async submitComposer() {
    const text = this.elements.composer.value;
    if (!text.trim() || !this.currentSession) return;
    const reasoningSeconds = this.#reasoningSeconds();
    const typingMs = this.typingStartedAt == null ? 0 : Math.max(0, performance.now() - this.typingStartedAt);
    await this.repository.recordInputStatistics({
      typedChars: text.length,
      deletedChars: this.deletedChars,
      typingMs,
    });
    await this.utterances.submit({ sessionId: this.currentSession.id, text, reasoningSeconds });
    this.elements.composer.value = "";
    this.elements.composer.setSelectionRange(0, 0);
    this.typingStartedAt = null;
    this.deletedChars = 0;
    this.focusComposer();
    await this.refreshAll();
    this.#broadcast();
  }

  focusComposer() {
    this.elements.composer.focus({ preventScroll: true });
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
      const editor = node.querySelector(".pending-editor");
      const save = node.querySelector(".pending-save");
      const cancel = node.querySelector(".pending-cancel");
      const error = node.querySelector(".pending-error");
      editor.value = item.text;
      const revisionable = this.utterances.isRevisionable(item.id);
      editor.disabled = !revisionable;
      save.disabled = !revisionable;
      if (item.error) {
        error.hidden = false;
        error.textContent = item.error;
      }
      save.addEventListener("click", async () => {
        try {
          await this.utterances.edit(item.id, editor.value, this.#reasoningSeconds());
          await this.refreshAll();
          this.#broadcast();
        } catch (editError) {
          this.elements.status.textContent = editError instanceof Error ? editError.message : String(editError);
        }
      });
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
    this.#updatePendingTimers();
  }

  #updatePendingTimers() {
    const currentTime = Date.now();
    for (const node of this.elements.pendingList.querySelectorAll(".pending-card")) {
      const job = this.utterances.jobs.get(node.dataset.pendingId);
      if (!job) continue;
      const remaining = Math.max(0, job.reasoningDeadline - currentTime) / 1000;
      node.querySelector(".pending-timer").textContent = remaining > 0 ? `${remaining.toFixed(1)}秒` : "確定待ち";
      node.querySelector(".pending-state").textContent = job.state === "voice-error" ? "音声エラー" : "読み上げ待ち";
    }
  }

  #bindEvents() {
    this.elements.submitButton.addEventListener("click", () => void this.#runUiTask(() => this.submitComposer()));
    this.elements.newConversation.addEventListener("click", () => void this.#runUiTask(() => this.createConversation()));
    this.elements.focusComposer.addEventListener("click", () => this.focusComposer());
    this.elements.historyToggle.addEventListener("click", () => {
      const open = this.elements.historyPanel.classList.toggle("open");
      this.elements.historyToggle.setAttribute("aria-expanded", String(open));
    });
    this.elements.reasoningSeconds.addEventListener("change", () => {
      const value = this.#reasoningSeconds();
      this.elements.reasoningSeconds.value = String(value);
      void this.repository.setSetting("reasoningSeconds", value);
    });
    this.elements.composer.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        void this.#runUiTask(() => this.submitComposer());
      }
    });
    this.elements.composer.addEventListener("beforeinput", (event) => {
      if (this.typingStartedAt == null) this.typingStartedAt = performance.now();
      if (event.inputType?.startsWith("delete")) this.deletedChars += 1;
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
      submitButton: byId("submit-button"),
      focusComposer: byId("focus-composer"),
      status: byId("app-status"),
      conversationTitle: byId("conversation-title"),

      pendingList: byId("pending-list"),
      pendingCount: byId("pending-count"),
      messageList: byId("message-list"),
      emptyTimeline: byId("empty-timeline"),
      conversationList: byId("conversation-list"),
      historyPanel: byId("history-panel"),
      historyToggle: byId("history-toggle"),
      newConversation: byId("new-conversation"),
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
