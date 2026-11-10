"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, useSyncExternalStore, type ReactNode } from "react";
import type { Vocabulary } from "@/hooks/use-vocabulary";
import type { ArticleSelectionSource, CompanionSelectionRequest } from "@/lib/companion-events";
import { companionPreferencesStore, updateCompanionPreferences } from "@/lib/companion-preferences";
import { learningContextStore, localProfileAllowed, refreshLearningContext } from "@/lib/learning-context-client";
import { localPracticeGeneration, practiceGenerationCurrent, readLocalPracticeData, writeLocalPracticeData, type PracticeGeneration } from "@/lib/local-practice-generation";
import { buildLearnerProfile } from "@/lib/learner-profile";
import { headwordLookup } from "@/lib/mistakes";
import type { ChatRequest, ChatActivityAction } from "@/lib/assistant/chat-contract";
import { requestCompanion } from "./chat-client";
import { requestHistory } from "./history";
import { classifyTask, buildRequest, resolveRoute, routeTable, type Fallback, type SelectionAction } from "./routing";
import { quoteContext, type Quote } from "./selection";
import { attachmentText, checkFile, readAttachment, type Attachment } from "./sources";
import { COMPANION_HISTORY_PREFIX, parseStoredConversations, serializeConversations } from "./persistence";
import { DEFAULT_SETTINGS, type Action, type AssistantMessage, type Block, type Caption, type Conversation, type Draft, type LearnView, type Message, type PracticeResult, type Settings, type SettingsSection, type View } from "./types";

export type State = {
  settings: Settings; conversations: Conversation[]; activeId: string; returnToId: string | null;
  drafts: Record<string, Draft>; notices: Record<string, ComposerNotice | undefined>;
  view: View; lastLearnView: LearnView; miniOpen: boolean; voiceOpen: boolean; generation: number;
  settingsOpen: SettingsSection | null; announcement: string; focusNonce: number; connected: boolean;
};
export type ComposerNotice = { message: string; alternatives: Fallback[] };
export const newId = (prefix: string) => `${prefix}-${crypto.randomUUID()}`;
export function emptyDraft(settings: Settings, temporary = false): Draft {
  return { text: "", quotes: [], attachments: [], includeRecords: !temporary && settings.includeRecords, includeArticle: settings.includeArticle };
}
export function hasDraftContent(draft?: Draft) { return Boolean(draft && (draft.text.trim() || draft.quotes.length || draft.attachments.length)); }
function blankConversation(temporary: boolean): Conversation {
  const at = Date.now();
  return { id: newId(temporary ? "temp" : "conv"), title: temporary ? "临时对话" : "新对话", temporary, createdAt: at, updatedAt: at, messages: [] };
}
function initialState(view: View = "today", generation = 0, temporary = false): State {
  const fresh = blankConversation(temporary), settings = { ...DEFAULT_SETTINGS, ...companionPreferencesStore.get() };
  return { settings, conversations: [fresh], activeId: fresh.id, returnToId: null, drafts: { [fresh.id]: emptyDraft(settings, temporary) }, notices: {}, view, lastLearnView: view === "chat" ? "today" : view, miniOpen: false, voiceOpen: false, generation, settingsOpen: null, announcement: "", focusNonce: 0, connected: false };
}
export type StoreAction =
  | { type: "settings"; patch: Partial<Settings> }
  | { type: "view"; view: View }
  | { type: "mini"; open: boolean }
  | { type: "voice-open"; open: boolean }
  | { type: "settings-open"; section: SettingsSection | null }
  | { type: "new"; conversation: Conversation }
  | { type: "select"; id: string }
  | { type: "delete"; id: string; fresh: Conversation }
  | { type: "reset"; state: State }
  | { type: "hydrate"; conversations: Conversation[] }
  | { type: "connected" }
  | { type: "draft"; id: string; patch: Partial<Draft> | ((draft: Draft) => Partial<Draft>) }
  | { type: "notice"; id: string; notice: ComposerNotice | undefined }
  | { type: "append"; id: string; messages: Message[]; title?: string }
  | { type: "replace-reply"; id: string; messageId: string; patch: Partial<AssistantMessage>; generation: number }
  | { type: "conversation-model"; id: string; model: Conversation["model"] }
  | { type: "announce"; text: string }
  | { type: "focus-composer" };
function patchConversation(state: State, id: string, patch: (c: Conversation) => Conversation): State {
  if (!state.conversations.some((c) => c.id === id)) return state;
  return { ...state, conversations: state.conversations.map((c) => c.id === id ? patch(c) : c) };
}
export function companionReducer(state: State, action: StoreAction): State {
  switch (action.type) {
    case "settings": return { ...state, settings: { ...state.settings, ...action.patch } };
    case "view": return action.view === state.view ? state : { ...state, view: action.view, lastLearnView: action.view === "chat" ? state.lastLearnView : action.view, miniOpen: action.view === "chat" ? false : state.miniOpen, voiceOpen: action.view === "chat" && state.voiceOpen };
    case "mini": return { ...state, miniOpen: action.open };
    case "voice-open": return { ...state, voiceOpen: action.open, ...(action.open ? { view: "chat" as const, miniOpen: false } : {}) };
    case "settings-open": return { ...state, settingsOpen: action.section };
    case "reset": return action.state;
    case "connected": return { ...state, connected: true };
    case "hydrate": return { ...state, conversations: [...state.conversations, ...action.conversations.filter((c) => !state.conversations.some((own) => own.id === c.id))] };
    case "new": {
      const current = state.conversations.find((c) => c.id === state.activeId);
      const drop = current && (current.temporary || (!current.messages.length && !hasDraftContent(state.drafts[current.id])));
      const drafts = { ...state.drafts, [action.conversation.id]: emptyDraft(state.settings, action.conversation.temporary) };
      if (drop) delete drafts[current.id];
      return { ...state, conversations: [action.conversation, ...state.conversations.filter((c) => !drop || c.id !== current.id)], activeId: action.conversation.id, returnToId: null, drafts, voiceOpen: false };
    }
    case "select": {
      const target = state.conversations.find((c) => c.id === action.id);
      if (!target || target.id === state.activeId) return state;
      const previous = state.conversations.find((c) => c.id === state.activeId);
      const drafts = { ...state.drafts };
      if (previous?.temporary) delete drafts[previous.id];
      return { ...state, conversations: state.conversations.filter((c) => !previous?.temporary || c.id !== previous.id), activeId: target.id, returnToId: previous && !previous.temporary && previous.messages.length ? previous.id : null, voiceOpen: false, drafts: { ...drafts, [target.id]: drafts[target.id] ?? emptyDraft(state.settings, target.temporary) } };
    }
    case "delete": {
      const remaining = state.conversations.filter((c) => c.id !== action.id), drafts = { ...state.drafts };
      delete drafts[action.id];
      const next = state.activeId === action.id ? remaining[0] ?? action.fresh : remaining.find((c) => c.id === state.activeId) ?? action.fresh;
      if (!remaining.length) remaining.push(next);
      return { ...state, conversations: remaining, activeId: next.id, drafts: { ...drafts, [next.id]: drafts[next.id] ?? emptyDraft(state.settings, next.temporary) }, returnToId: state.returnToId === action.id ? null : state.returnToId, voiceOpen: false };
    }
    case "draft": {
      const draft = state.drafts[action.id];
      if (!draft) return state;
      return { ...state, drafts: { ...state.drafts, [action.id]: { ...draft, ...(typeof action.patch === "function" ? action.patch(draft) : action.patch) } } };
    }
    case "notice": return { ...state, notices: { ...state.notices, [action.id]: action.notice } };
    case "append": return patchConversation(state, action.id, (c) => ({ ...c, updatedAt: Date.now(), title: c.messages.length || !action.title ? c.title : action.title, messages: [...c.messages, ...action.messages].slice(-120) }));
    case "replace-reply":
      if (action.generation !== state.generation) return state;
      return patchConversation(state, action.id, (c) => ({ ...c, messages: c.messages.map((m) => m.role === "assistant" && m.id === action.messageId ? { ...m, ...action.patch } : m) }));
    case "conversation-model": return patchConversation(state, action.id, (c) => ({ ...c, model: action.model }));
    case "announce": return { ...state, announcement: action.text };
    case "focus-composer": return { ...state, focusNonce: state.focusNonce + 1 };
  }
}

export type SendOptions = { text?: string; quotes?: Quote[]; action?: SelectionAction; fallback?: Fallback; keepDraft?: boolean; via?: "text" | "action" | "voice"; articleAvailable?: boolean };
export type SendOutcome = { ok: true; blocks: Block[]; label: string } | { ok: false; reason: "empty" | "reading" | "blocked" | "missing" };
export type CompanionProviderProps = {
  children: ReactNode; data: Vocabulary; view: View; onNavigate: (view: View) => void;
  onOpenSettings: () => void; onPractice: (ids: string[], mode?: "dictation" | "review", title?: string, onResult?: (result: PracticeResult) => void) => void;
  onVoice?: () => void; article?: ArticleSelectionSource | null;
  /** Words due and weak in the learner's current scope, for the opening line. */
  study?: { due: number; weak: number };
  selectionRequest?: CompanionSelectionRequest | null; onSelectionConsumed?: (id: string) => void;
};
type Store = {
  state: State; active: Conversation; draft: Draft; currentArticle: ArticleSelectionSource | null; study?: { due: number; weak: number };
  dispatch: (action: StoreAction) => void; send: (id: string, options?: SendOptions) => SendOutcome;
  stop: (id: string) => void; setView: (view: View) => void; openChat: (id?: string) => void;
  newConversation: (temporary: boolean) => void; remove: (id: string) => void; clearAll: () => void;
  getState: () => State; continueReply: (id: string, messageId: string) => void;
  articleAvailable: (conversation: Conversation, draft: Draft) => boolean;
  runAction: (action: Action) => void; appendVoice: (id: string, captions: Caption[], seconds: number) => void;
  addFiles: (id: string, files: File[]) => Promise<void>; removeAttachment: (id: string, attachment: Attachment) => void;
};
const StoreContext = createContext<Store | null>(null);
export function useStore() { const store = useContext(StoreContext); if (!store) throw new Error("CompanionProvider missing"); return store; }
function activityActions(actions: ChatActivityAction[]): Action[] {
  return actions.slice(0, 3).map((action) => action.type === "open-reading"
    ? { id: newId("action"), intent: "open-reading", label: action.title || "打开阅读" }
    : { id: newId("action"), intent: action.type, label: action.title, title: action.title, wordIds: action.wordIds, minutes: action.minutes });
}

export function CompanionProvider(props: CompanionProviderProps) {
  const [state, reactDispatch] = useReducer(companionReducer, props.view, initialState);
  const stateRef = useRef(state), host = useRef(props);
  host.current = props;
  const currentArticle = useRef<ArticleSelectionSource | null>(props.article ?? null);
  if (props.article) currentArticle.current = props.article;
  const requests = useRef(new Map<string, { controller: AbortController; messageId: string }>());
  const fileReads = useRef(new Map<string, { controller: AbortController; conversationId: string }>());
  const identity = useRef<{ scope: string | null; generation: PracticeGeneration; ready: boolean; sequence: number }>({ scope: null, generation: localPracticeGeneration(), ready: false, sequence: 0 });
  const historySnapshot = useRef<{ raw: string | null; ids: Set<string> }>({ raw: null, ids: new Set() });
  const parked = useRef<{ state: State; scope: string; generation: PracticeGeneration; snapshot: { raw: string | null; ids: Set<string> } } | null>(null);
  const ownedAttachments = useRef(new Map<string, { attachment: Attachment; conversationId: string }>());
  const preferences = useSyncExternalStore(companionPreferencesStore.subscribe, companionPreferencesStore.get, companionPreferencesStore.getServerSnapshot);
  const dispatchRaw = useCallback((action: StoreAction) => {
    const previous = stateRef.current;
    stateRef.current = companionReducer(previous, action);
    if (action.type === "append") {
      const next = stateRef.current.conversations.find((c) => c.id === action.id);
      const kept = new Set(next?.messages.map((m) => m.id));
      for (const message of previous.conversations.find((c) => c.id === action.id)?.messages ?? []) {
        if (message.role !== "user" || kept.has(message.id)) continue;
        for (const attachment of message.attachments) {
          if (stateRef.current.drafts[action.id]?.attachments.some((a) => a.id === attachment.id)) continue;
          attachmentText.drop(attachment); ownedAttachments.current.delete(attachment.id);
        }
      }
    }
    reactDispatch(action);
  }, []);
  const cleanupConversation = useCallback((id: string) => {
    requests.current.get(id)?.controller.abort(); requests.current.delete(id);
    for (const [fileId, read] of fileReads.current) if (read.conversationId === id) { read.controller.abort(); fileReads.current.delete(fileId); }
    for (const [attachmentId, owned] of ownedAttachments.current) if (owned.conversationId === id) { attachmentText.drop(owned.attachment); ownedAttachments.current.delete(attachmentId); }
  }, []);
  const resetIdentity = useCallback(() => {
    for (const conversation of stateRef.current.conversations) cleanupConversation(conversation.id);
    if (parked.current) for (const conversation of parked.current.state.conversations) cleanupConversation(conversation.id);
    parked.current = null;
    historySnapshot.current = { raw: null, ids: new Set() };
    identity.current.sequence++; identity.current.scope = null; identity.current.ready = false; identity.current.generation = localPracticeGeneration();
    dispatchRaw({ type: "reset", state: initialState(host.current.view, stateRef.current.generation + 1, learningContextStore.get().temporary) });
  }, [cleanupConversation, dispatchRaw]);
  const pauseIdentity = useCallback(() => {
    if (identity.current.scope && !parked.current) parked.current = { state: stateRef.current, scope: identity.current.scope, generation: identity.current.generation, snapshot: historySnapshot.current };
    for (const pending of requests.current.values()) pending.controller.abort();
    requests.current.clear();
    for (const read of fileReads.current.values()) read.controller.abort();
    fileReads.current.clear();
    identity.current.sequence++; identity.current.scope = null; identity.current.ready = false;
    dispatchRaw({ type: "reset", state: initialState(host.current.view, stateRef.current.generation + 1) });
  }, [dispatchRaw]);
  const dispatch = useCallback((action: StoreAction) => {
    if (action.type === "view") host.current.onNavigate(action.view);
    if (action.type === "voice-open" && action.open) host.current.onNavigate("chat");
    if (action.type === "settings-open" && action.section) { host.current.onOpenSettings(); return; }
    if (action.type === "settings") updateCompanionPreferences(action.patch);
    if (action.type === "select") {
      const current = stateRef.current.conversations.find((c) => c.id === stateRef.current.activeId);
      if (current?.temporary && current.id !== action.id) cleanupConversation(current.id);
    }
    dispatchRaw(action);
  }, [cleanupConversation, dispatchRaw]);

  useEffect(() => { dispatchRaw({ type: "view", view: props.view }); }, [props.view, dispatchRaw]);
  useEffect(() => { dispatchRaw({ type: "settings", patch: { ...preferences, theme: props.data.settings.theme } }); }, [preferences, props.data.settings.theme, dispatchRaw]);
  useEffect(() => {
    let active = true;
    const adopt = async () => {
      const context = learningContextStore.get();
      const scope = context.memory?.accountScope;
      if (!scope) return;
      if (identity.current.scope === scope && identity.current.ready && practiceGenerationCurrent(identity.current.generation)) return;
      if ((identity.current.scope && identity.current.scope !== scope) || (parked.current && (parked.current.scope !== scope || !practiceGenerationCurrent(parked.current.generation)))) resetIdentity();
      const sequence = ++identity.current.sequence;
      identity.current.scope = scope; identity.current.ready = false;
      try {
        const loaded = await readLocalPracticeData((storage) => context.temporary ? null : storage.getItem(COMPANION_HISTORY_PREFIX + scope));
        if (!active || sequence !== identity.current.sequence || learningContextStore.get().memory?.accountScope !== scope) return;
        identity.current.generation = loaded.generation;
        const conversations = parseStoredConversations(loaded.value);
        const saved = parked.current;
        if (saved?.scope === scope && practiceGenerationCurrent(saved.generation)) {
          const old = saved.state;
          const retained = saved.snapshot.raw === loaded.value ? old.conversations : [...old.conversations.filter((c) => !saved.snapshot.ids.has(c.id)), ...conversations];
          const active = retained.find((c) => c.id === old.activeId) ?? retained[0] ?? blankConversation(false);
          if (!retained.length) retained.push(active);
          const retainedIds = new Set(retained.map((c) => c.id));
          for (const c of [...old.conversations, ...stateRef.current.conversations]) if (!retainedIds.has(c.id)) cleanupConversation(c.id);
          dispatchRaw({ type: "reset", state: { ...old, generation: stateRef.current.generation + 1, connected: false, voiceOpen: false,
            conversations: retained.map((c) => ({ ...c, messages: c.messages.map((m) => m.role === "assistant" && m.status === "streaming" ? { ...m, status: "stopped" } : m) })), activeId: active.id,
            drafts: Object.fromEntries(retained.map((c) => { const draft = old.drafts[c.id] ?? emptyDraft(old.settings, c.temporary); return [c.id, { ...draft, attachments: draft.attachments.map((a) => a.status === "reading" ? { ...a, status: "error", error: "读取已停止，请重新添加。" } : a) }]; })),
          } });
          parked.current = null;
        }
        historySnapshot.current = { raw: loaded.value, ids: new Set(conversations.map((c) => c.id)) };
        dispatchRaw({ type: "hydrate", conversations });
      } catch { /* memory-only conversations remain usable */ }
      if (active && sequence === identity.current.sequence) { identity.current.ready = true; dispatchRaw({ type: "connected" }); }
    };
    let previous = learningContextStore.get();
    const unsubscribe = learningContextStore.subscribe(() => {
      const next = learningContextStore.get();
      if ((previous.memory && next.memory && previous.memory.accountScope !== next.memory.accountScope) || previous.temporary !== next.temporary || !practiceGenerationCurrent(identity.current.generation)) resetIdentity();
      else if (previous.memory && !next.memory) pauseIdentity();
      const needsRefresh = Boolean(previous.memory && !next.memory) || previous.temporary !== next.temporary;
      previous = next;
      if (needsRefresh) void refreshLearningContext().then(adopt).catch(() => undefined);
      else void adopt();
    });
    void adopt();
    void refreshLearningContext().then(adopt).catch(() => undefined);
    return () => { active = false; unsubscribe(); for (const conversation of stateRef.current.conversations) cleanupConversation(conversation.id); if (parked.current) for (const conversation of parked.current.state.conversations) cleanupConversation(conversation.id); };
  }, [cleanupConversation, dispatchRaw, pauseIdentity, resetIdentity]);
  const synchronizeHistory = useCallback((raw: string | null) => {
    const scope = identity.current.scope;
    if (!scope || learningContextStore.get().memory?.accountScope !== scope || raw === historySnapshot.current.raw) return;
    const incoming = parseStoredConversations(raw), incomingIds = new Set(incoming.map((c) => c.id));
    const previous = stateRef.current, oldIds = historySnapshot.current.ids;
    const local = raw === null ? [] : previous.conversations.filter((c) => !oldIds.has(c.id) && !incomingIds.has(c.id));
    const keep = [...local, ...incoming].map((c) => ({ ...c, messages: c.messages.map((m): Message => m.role === "assistant" && m.status === "streaming" ? { ...m, status: "stopped" } : m) }));
    const ids = new Set(keep.map((c) => c.id));
    for (const [id, pending] of requests.current) { pending.controller.abort(); requests.current.delete(id); }
    for (const conversation of previous.conversations) if (!ids.has(conversation.id)) cleanupConversation(conversation.id);
    const active = keep.find((c) => c.id === previous.activeId) ?? keep[0] ?? blankConversation(false);
    if (!keep.length) keep.push(active);
    const drafts = Object.fromEntries(keep.map((c) => [c.id, previous.drafts[c.id] ?? emptyDraft(previous.settings, c.temporary)]));
    historySnapshot.current = { raw, ids: incomingIds };
    dispatchRaw({ type: "reset", state: { ...previous, conversations: keep, activeId: active.id, drafts, generation: previous.generation + 1, voiceOpen: false, returnToId: null, announcement: "对话已更新" } });
  }, [cleanupConversation, dispatchRaw]);
  useEffect(() => {
    const changed = (event: StorageEvent) => {
      if (event.key === COMPANION_HISTORY_PREFIX + identity.current.scope || event.key === null) synchronizeHistory(event.newValue);
    };
    window.addEventListener("storage", changed);
    return () => window.removeEventListener("storage", changed);
  }, [synchronizeHistory]);
  useEffect(() => {
    const scope = identity.current.scope, generation = identity.current.generation, sequence = identity.current.sequence;
    const expected = historySnapshot.current.raw, stateGeneration = state.generation;
    if (!scope || !identity.current.ready || learningContextStore.get().temporary) return;
    const timer = setTimeout(() => {
      const serialized = serializeConversations(state.conversations);
      void writeLocalPracticeData(generation, (storage) => {
        if (identity.current.scope !== scope || identity.current.sequence !== sequence || stateRef.current.generation !== stateGeneration || learningContextStore.get().memory?.accountScope !== scope) return;
        const actual = storage.getItem(COMPANION_HISTORY_PREFIX + scope);
        if (actual !== expected) { synchronizeHistory(actual); return; }
        storage.setItem(COMPANION_HISTORY_PREFIX + scope, serialized);
        historySnapshot.current = { raw: serialized, ids: new Set(parseStoredConversations(serialized).map((c) => c.id)) };
      }).catch(() => undefined);
    }, 250);
    return () => clearTimeout(timer);
  }, [state.conversations, state.connected, state.generation, synchronizeHistory]);

  const articleAvailable = useCallback((_conversation: Conversation, draft: Draft) => Boolean(currentArticle.current && (stateRef.current.view === "reading" || stateRef.current.lastLearnView === "reading" || draft.quotes.some((q) => q.articleId === currentArticle.current?.id))), []);
  const send = useCallback((conversationId: string, options: SendOptions = {}): SendOutcome => {
    const current = stateRef.current, conversation = current.conversations.find((c) => c.id === conversationId), draft = current.drafts[conversationId];
    if (!conversation || !draft) return { ok: false, reason: "missing" };
    if (requests.current.has(conversationId)) return { ok: false, reason: "blocked" };
    const original = (options.text ?? draft.text).trim(), quotes = options.quotes ?? (options.keepDraft ? [] : draft.quotes), attachments = options.keepDraft ? [] : draft.attachments;
    if (!original && !quotes.some((q) => !q.carried) && !attachments.length) return { ok: false, reason: "empty" };
    const notice = (message: string) => dispatchRaw({ type: "notice", id: conversationId, notice: { message, alternatives: [] } });
    if (!identity.current.scope || !identity.current.ready) { notice(learningContextStore.get().error || "正在连接账户，请稍后重试。"); void refreshLearningContext().catch(() => undefined); return { ok: false, reason: "blocked" }; }
    if (attachments.some((a) => a.status === "reading")) { notice("附件还在读取，请稍候。"); return { ok: false, reason: "reading" }; }
    if (attachments.some((a) => a.status !== "read")) { notice("请移除读取失败的附件后发送。"); return { ok: false, reason: "blocked" }; }
    if (original.length > 6000) { notice("一条消息最多 6,000 字，请分段发送。"); return { ok: false, reason: "blocked" }; }
    const files = attachments.flatMap((a) => { const text = attachmentText.get(a.id); return text ? [{ name: a.name, text }] : []; });
    if (files.reduce((n, f) => n + f.text.length, 0) > 12000) { notice("附件文字合计最多 12,000 字，请减少附件或缩短内容。"); return { ok: false, reason: "blocked" }; }
    const text = original || (quotes.length ? "请解释这段原文。" : "请帮我理解附件中的文字。");
    const temporary = conversation.temporary || learningContextStore.get().temporary;
    const includeRecords = !temporary && draft.includeRecords;
    const memory = learningContextStore.get().memory;
    const data = host.current.data;
    const profile = includeRecords && localProfileAllowed(memory) ? buildLearnerProfile({ reviews: data.history.active, cards: data.cards, lookup: headwordLookup(data.index) }) : null;
    const wordIds = profile?.weakWords.map((w) => w.id) ?? data.index.filter((word) => word.sources.some((source) => data.settings.selectedBooks.includes(source.bookId))).slice(0, 32).map((word) => word.id);
    const available = options.articleAvailable ?? articleAvailable(conversation, draft);
    const article = draft.includeArticle && available ? currentArticle.current : null;
    const classification = classifyTask({ text, action: options.action, hasQuote: quotes.length > 0 });
    const choice = options.fallback?.model ?? conversation.model ?? current.settings.routePreference;
    const route = resolveRoute(classification, { conversation: choice, preference: "auto" }, routeTable(current.settings.complexPlanTier));
    const metadata = buildRequest(route, { records: includeRecords, article: article ? "full" : available ? "off" : "none", quotes: quotes.length, quoteChars: quotes.reduce((n, q) => n + q.text.length, 0), readFiles: files.map((f) => ({ name: f.name, chars: f.text.length })), attachmentsOnly: [] });
    const request: ChatRequest = {
      messages: requestHistory(conversation.messages, text), model: choice === "gpt-6.1-sol" ? "sol" : choice === "gpt-6.1-terra" ? "terra" : "auto",
      ...(options.action ? { action: options.action } : {}),
      quotes: quotes.slice(0, 4).map((q) => { const context = quoteContext(q.articleId === article?.id ? article : null, q); return { text: q.text, title: q.title, before: context.before.slice(-600), after: context.after.slice(0, 600) }; }),
      ...(article ? { article: { title: article.title, text: article.paragraphs.map((p) => p.text).join("\n\n").slice(0, 12000) } } : {}),
      files, wordIds, includeRecords, temporary, ...(profile ? { profile } : {}),
    };
    const controller = new AbortController(), now = Date.now(), messageId = newId("a"), generation = current.generation, scope = identity.current.scope;
    requests.current.set(conversationId, { controller, messageId });
    const user: Message = { id: newId("u"), role: "user", at: now, text: original, quotes, attachments, via: options.via ?? (options.action ? "action" : "text"), action: options.action };
    const reply: AssistantMessage = { id: messageId, role: "assistant", at: now, status: "streaming", blocks: [], revealed: 0, request: metadata, routeReason: "" };
    dispatchRaw({ type: "append", id: conversationId, messages: [user, reply], title: (original || quotes[0]?.title || attachments[0]?.name || "对话").slice(0, 32) });
    dispatchRaw({ type: "notice", id: conversationId, notice: undefined });
    dispatchRaw({ type: "draft", id: conversationId, patch: (latest) => options.keepDraft ? { quotes: latest.quotes.length ? latest.quotes : quotes.slice(0, 1).map((q) => ({ ...q, carried: true })) } : { text: "", attachments: [], quotes: quotes.slice(0, 1).map((q) => ({ ...q, carried: true })) } });
    void requestCompanion(request, controller.signal, scope).then((response) => {
      if (controller.signal.aborted || identity.current.scope !== scope || stateRef.current.generation !== generation) return;
      const blocks: Block[] = [{ type: "text", text: response.result.text }];
      if (response.steps.length) blocks.unshift({ type: "steps", labels: [...new Set(response.steps.map((step) => step.label))] });
      if (response.result.actions.length) blocks.push({ type: "actions", actions: activityActions(response.result.actions) });
      dispatchRaw({ type: "replace-reply", id: conversationId, messageId, generation, patch: { status: "done", blocks, revealed: response.result.text.length, request: { ...metadata, model: response.model, reasoning: { effort: response.effort } } } });
      dispatchRaw({ type: "announce", text: "回答完成" });
    }).catch((error: unknown) => {
      if (controller.signal.aborted || stateRef.current.generation !== generation || identity.current.scope !== scope) return;
      const message = error instanceof Error ? error.message : "发送失败，请重试。";
      dispatchRaw({ type: "replace-reply", id: conversationId, messageId, generation, patch: { status: "error", blocks: [{ type: "notice", tone: "warn", text: message }] } });
    }).finally(() => { if (requests.current.get(conversationId)?.messageId === messageId) requests.current.delete(conversationId); });
    return { ok: true, blocks: [], label: choice === "auto" ? "自动" : choice };
  }, [articleAvailable, dispatchRaw]);
  const stop = useCallback((id: string) => {
    const pending = requests.current.get(id);
    if (!pending) return;
    pending.controller.abort(); requests.current.delete(id);
    dispatchRaw({ type: "replace-reply", id, messageId: pending.messageId, generation: stateRef.current.generation, patch: { status: "stopped" } });
  }, [dispatchRaw]);
  const newConversation = useCallback((temporary: boolean) => {
    const previous = stateRef.current.conversations.find((c) => c.id === stateRef.current.activeId);
    if (previous?.temporary || (previous && !previous.messages.length && !hasDraftContent(stateRef.current.drafts[previous.id]))) cleanupConversation(previous.id);
    dispatchRaw({ type: "new", conversation: blankConversation(temporary) });
  }, [cleanupConversation, dispatchRaw]);
  const remove = useCallback((id: string) => { cleanupConversation(id); dispatchRaw({ type: "delete", id, fresh: blankConversation(false) }); }, [cleanupConversation, dispatchRaw]);
  const clearAll = useCallback(() => {
    for (const c of stateRef.current.conversations) cleanupConversation(c.id);
    dispatchRaw({ type: "reset", state: { ...initialState(host.current.view, stateRef.current.generation + 1), connected: identity.current.ready } });
    const scope = identity.current.scope;
    if (scope) void writeLocalPracticeData(identity.current.generation, (storage) => {
      if (identity.current.scope !== scope) return;
      storage.removeItem(COMPANION_HISTORY_PREFIX + scope);
      historySnapshot.current = { raw: null, ids: new Set() };
    }).catch(() => undefined);
  }, [cleanupConversation, dispatchRaw]);
  const getState = useCallback(() => stateRef.current, []);
  const setView = useCallback((view: View) => dispatch({ type: "view", view }), [dispatch]);
  const openChat = useCallback((id?: string) => { if (id) dispatch({ type: "select", id }); dispatch({ type: "view", view: "chat" }); }, [dispatch]);
  const continueReply = useCallback((id: string) => { send(id, { text: "请继续上一条回答。", keepDraft: true }); }, [send]);
  const runAction = useCallback((action: Action) => {
    if (action.intent === "open-reading") setView("reading");
    else if (action.intent === "send") send(stateRef.current.activeId, { text: action.text, keepDraft: true });
    else if (action.intent === "open-settings") host.current.onOpenSettings();
    else {
      const id = stateRef.current.activeId, scope = identity.current.scope, generation = identity.current.generation;
      dispatchRaw({ type: "mini", open: false });
      host.current.onPractice(action.wordIds, action.intent === "start-review" ? "review" : "dictation", action.title, (result) => {
        if (!scope || identity.current.scope !== scope || !practiceGenerationCurrent(generation) || !stateRef.current.conversations.some((c) => c.id === id) || !result.rounds.some((r) => r.length)) return;
        dispatchRaw({ type: "append", id, messages: [{ id: newId("result"), role: "result", at: Date.now(), result }] });
        dispatch({ type: "select", id });
        setView("chat");
      });
    }
  }, [dispatch, dispatchRaw, send, setView]);
  const appendVoice = useCallback((id: string, captions: Caption[], seconds: number) => {
    if (!captions.length || !stateRef.current.conversations.some((c) => c.id === id) || !practiceGenerationCurrent(identity.current.generation)) return;
    dispatchRaw({ type: "append", id, messages: [{ id: newId("voice"), role: "voice", at: Date.now(), captions: captions.slice(-100), seconds }], title: `语音 · ${captions.find((c) => c.speaker === "user")?.text.slice(0, 20) || "对话"}` });
  }, [dispatchRaw]);
  const removeAttachment = useCallback((id: string, attachment: Attachment) => {
    fileReads.current.get(attachment.id)?.controller.abort(); fileReads.current.delete(attachment.id); attachmentText.drop(attachment); ownedAttachments.current.delete(attachment.id);
    dispatchRaw({ type: "draft", id, patch: (draft) => ({ attachments: draft.attachments.filter((a) => a.id !== attachment.id) }) });
  }, [dispatchRaw]);
  const addFiles = useCallback(async (id: string, files: File[]) => {
    const generation = stateRef.current.generation, storageGeneration = localPracticeGeneration();
    for (const file of files) {
      const draft = stateRef.current.drafts[id]; if (!draft || generation !== stateRef.current.generation) return;
      const checked = checkFile(file.name, file.type, file.size, draft.attachments.length);
      if (!checked.ok) { dispatchRaw({ type: "notice", id, notice: { message: checked.message, alternatives: [] } }); continue; }
      const attachment: Attachment = { id: newId("file"), name: file.name.slice(0, 180), kind: checked.kind, size: file.size, status: "reading", ...(checked.kind === "image" ? { previewUrl: URL.createObjectURL(file) } : {}) };
      const controller = new AbortController(); fileReads.current.set(attachment.id, { controller, conversationId: id });
      ownedAttachments.current.set(attachment.id, { attachment, conversationId: id });
      dispatchRaw({ type: "draft", id, patch: (current) => ({ attachments: [...current.attachments, attachment] }) });
      const present = () => !controller.signal.aborted && practiceGenerationCurrent(storageGeneration) && stateRef.current.drafts[id]?.attachments.some((a) => a.id === attachment.id);
      try {
        const result = await readAttachment(file, checked.kind, controller.signal);
        if (!present()) continue;
        attachmentText.set(attachment.id, result.text);
        dispatchRaw({ type: "draft", id, patch: (current) => ({ attachments: current.attachments.map((a) => a.id === attachment.id ? { ...a, status: "read", chars: result.chars, truncated: result.truncated } : a) }) });
      } catch (error) {
        if (present()) dispatchRaw({ type: "draft", id, patch: (current) => ({ attachments: current.attachments.map((a) => a.id === attachment.id ? { ...a, status: "error", error: error instanceof Error ? error.message : "文件读取失败。" } : a) }) });
      } finally { fileReads.current.delete(attachment.id); }
    }
  }, [dispatchRaw]);
  const handledSelection = useRef<string | null>(null);
  useEffect(() => {
    const request = props.selectionRequest;
    if (!request || handledSelection.current === request.id || (request.action !== "ask" && !state.connected)) return;
    handledSelection.current = request.id; currentArticle.current = request.article;
    const id = stateRef.current.activeId;
    dispatchRaw({ type: "draft", id, patch: (draft) => ({ quotes: [...draft.quotes.filter((q) => !q.carried && q.id !== request.quote.id).slice(-3), request.quote], ...(request.action === "ask" && !draft.text.trim() ? { text: "这段在说什么？" } : {}) }) });
    dispatchRaw({ type: "mini", open: true }); dispatchRaw({ type: "focus-composer" });
    if (request.action !== "ask") {
      const labels = { translate: "翻译这段原文", define: "解释这里的词义", grammar: "分析这段的语法" };
      send(id, { text: labels[request.action], quotes: [request.quote], action: request.action, keepDraft: true, articleAvailable: true });
    }
    host.current.onSelectionConsumed?.(request.id);
  }, [props.selectionRequest, state.connected, dispatchRaw, send]);
  const active = state.conversations.find((c) => c.id === state.activeId) ?? state.conversations[0];
  const draft = state.drafts[active.id] ?? emptyDraft(state.settings, active.temporary);
  const article = props.article ?? currentArticle.current;
  const study = props.study;
  const value = useMemo<Store>(() => ({ state, active, draft, currentArticle: article, study, dispatch, send, stop, setView, openChat, newConversation, remove, clearAll, getState, continueReply, articleAvailable, runAction, appendVoice, addFiles, removeAttachment }), [state, active, draft, dispatch, send, stop, setView, openChat, newConversation, remove, clearAll, getState, continueReply, articleAvailable, runAction, appendVoice, addFiles, removeAttachment, article, study]);
  return <StoreContext.Provider value={value}>{props.children}</StoreContext.Provider>;
}
export const StoreProvider = CompanionProvider;
