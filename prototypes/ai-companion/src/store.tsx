"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, type ReactNode } from "react";
import { ARTICLE, sentenceSpans } from "./data";
import { respond, streamLength } from "./engine";
import { buildPlan, type PlanSpec, type PracticeItem } from "./practice";
import {
  applyFallback, buildRequest, checkSendable, classifyTask, isModelChoice, requestLabel, resolveRoute, routeTable,
  type ContextSummary, type Fallback, type ModelChoice, type RequestPayload, type SelectionAction,
} from "./routing";
import { paragraphLabel, quoteFromPoints, type Quote } from "./selection";
import { attachmentText, type Attachment } from "./sources";
import { parseStoredConversations, remainderBlocks, serializeConversations, truncateBlocks } from "./persistence";
import {
  DEFAULT_SETTINGS, type AssistantMessage, type Block, type Caption, type Conversation, type Draft, type LearnView,
  type Message, type PracticeResult, type RoundAnswer, type Settings, type SettingsSection, type View,
} from "./types";

const STORAGE_KEY = "ciji-ai-prototype:v1";

export type ComposerNotice = { message: string; alternatives: Fallback[] };
export type PracticeSession = {
  id: string; convId: string | null; origin: "full" | "mini" | "page";
  title: string; source: string; items: PracticeItem[];
  rounds: RoundAnswer[][]; current: RoundAnswer[]; index: number; finished: boolean; returned: boolean;
};
export type State = {
  settings: Settings;
  conversations: Conversation[];
  activeId: string;
  returnToId: string | null;
  drafts: Record<string, Draft>;
  notices: Record<string, ComposerNotice | undefined>;
  view: View;
  lastLearnView: LearnView;
  miniOpen: boolean;
  practice: PracticeSession | null;
  generation: number;
  settingsOpen: SettingsSection | null;
  voiceOpen: boolean;
  announcement: string;
  /** Raised when an explicit action should put the cursor in the visible composer. */
  focusNonce: number;
};

let idCounter = 0;
export const newId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${(++idCounter).toString(36)}`;

export function emptyDraft(settings: Settings): Draft {
  return { text: "", quotes: [], attachments: [], includeRecords: settings.includeRecords, includeArticle: settings.includeArticle };
}
function blankConversation(temporary: boolean): Conversation {
  const now = Date.now();
  return { id: newId(temporary ? "temp" : "conv"), title: temporary ? "临时对话" : "新对话", temporary, createdAt: now, updatedAt: now, messages: [] };
}

function readStorage<T>(key: string, parse: (raw: string | null) => T): T {
  try { return parse(window.localStorage.getItem(key)); } catch { return parse(null); }
}
function writeStorage(key: string, value: string | null) {
  try { if (value === null) window.localStorage.removeItem(key); else window.localStorage.setItem(key, value); } catch { /* storage unavailable: the prototype keeps working in memory */ }
}

function sampleRequest(task: Parameters<typeof resolveRoute>[0], context: Partial<ContextSummary> = {}): { request: RequestPayload; routeReason: string } {
  const route = resolveRoute(task, { preference: "auto" }, routeTable("sol-high"));
  return { request: buildRequest(route, { records: false, article: "none", quotes: 0, quoteChars: 0, readFiles: [], attachmentsOnly: [], ...context }), routeReason: route.reason };
}

/** Two example conversations so history can be browsed on first visit. They are labelled as examples. */
function sampleConversations(): Conversation[] {
  const day = 24 * 60 * 60 * 1000;
  const now = Date.now();
  const status = sampleRequest({ task: "status", signals: ["询问学习状态"] }, { records: true });
  const spans = sentenceSpans(ARTICLE.paragraphs[1]);
  const picked = quoteFromPoints(ARTICLE, { paragraph: 1, offset: spans[1].start }, { paragraph: 1, offset: spans[1].end });
  const quote = picked.ok ? picked.quote : null;
  const translate = sampleRequest({ task: "translate", signals: ["阅读工具栏动作"] }, { article: "full", quotes: 1, quoteChars: quote?.text.length ?? 0 });
  const conversations: Conversation[] = [{
    id: "sample-status", title: "这周的复习安排", temporary: false, sample: true, createdAt: now - 2 * day, updatedAt: now - 2 * day,
    messages: [
      { id: "sample-status-u", role: "user", at: now - 2 * day, text: "看看我这周的学习状态", quotes: [], attachments: [], via: "text" },
      {
        id: "sample-status-a", role: "assistant", at: now - 2 * day, status: "done", revealed: 0, ...status,
        blocks: [{ type: "text", text: "按这周的练习表现整理如下。依据是作答对错和错误类型，不按聊天次数打分。注意：这里用的是原型示例记录。" }, { type: "status" }],
      },
    ],
  }];
  if (quote) {
    conversations.push({
      id: "sample-reading", title: `翻译 · ${ARTICLE.title} ${paragraphLabel(quote)}`, temporary: false, sample: true, createdAt: now - 4 * day, updatedAt: now - 4 * day,
      messages: [
        { id: "sample-reading-u", role: "user", at: now - 4 * day, text: "翻译这段", quotes: [quote], attachments: [], via: "action", action: "translate" },
        {
          id: "sample-reading-a", role: "assistant", at: now - 4 * day, status: "done", revealed: 0, ...translate,
          blocks: [{ type: "text", text: "下面是选文的译文。" }, { type: "quote-answer", mode: "translate", quote }],
        },
      ],
    });
  }
  return conversations;
}

function initialState(): State {
  const saved = { ...DEFAULT_SETTINGS, ...readStorage(`${STORAGE_KEY}:settings`, (raw) => { try { return raw ? JSON.parse(raw) as Partial<Settings> : {}; } catch { return {}; } }) };
  // Earlier prototype builds stored a model-and-effort tier; anything else returns to automatic.
  const settings: Settings = { ...saved, routePreference: isModelChoice(saved.routePreference) ? saved.routePreference : "auto" };
  const stored = readStorage(STORAGE_KEY, parseStoredConversations);
  const conversations = stored ?? sampleConversations();
  const blank = blankConversation(false);
  const hash = typeof window === "undefined" ? "" : window.location.hash.slice(1);
  const view: View = (["today", "words", "reading", "records", "dictation", "chat"] as const).find((name) => name === hash) ?? "chat";
  return {
    settings, conversations: [blank, ...conversations], activeId: blank.id, returnToId: null,
    drafts: { [blank.id]: emptyDraft(settings) }, notices: {}, view, lastLearnView: view === "chat" ? "today" : view,
    miniOpen: false, practice: null, generation: 0, settingsOpen: null, voiceOpen: false, announcement: "", focusNonce: 0,
  };
}

type ActionType =
  | { type: "settings"; patch: Partial<Settings> }
  | { type: "view"; view: View }
  | { type: "mini"; open: boolean }
  | { type: "settings-open"; section: SettingsSection | null }
  | { type: "voice-open"; open: boolean }
  | { type: "new"; conversation: Conversation }
  | { type: "select"; id: string }
  | { type: "delete"; id: string; fresh: Conversation }
  | { type: "clear-all"; fresh: Conversation }
  | { type: "draft"; id: string; patch: Partial<Draft> | ((draft: Draft) => Partial<Draft>) }
  | { type: "notice"; id: string; notice: ComposerNotice | undefined }
  | { type: "append"; id: string; messages: Message[]; title?: string }
  | { type: "reveal"; id: string; messageId: string; revealed: number; generation: number }
  | { type: "finish"; id: string; messageId: string; status: AssistantMessage["status"]; generation: number }
  | { type: "block"; id: string; messageId: string; index: number; block: Block }
  | { type: "drop-remainder"; id: string; messageId: string }
  | { type: "conversation-model"; id: string; model: ModelChoice }
  | { type: "practice"; session: PracticeSession | null }
  | { type: "announce"; text: string }
  | { type: "focus-composer" };

function patchConversation(state: State, id: string, update: (conversation: Conversation) => Conversation): State {
  let changed = false;
  const conversations = state.conversations.map((conversation) => {
    if (conversation.id !== id) return conversation;
    changed = true;
    return update(conversation);
  });
  return changed ? { ...state, conversations } : state;
}

function dropAttachments(conversation: Conversation, draft: Draft | undefined) {
  for (const attachment of draft?.attachments ?? []) attachmentText.drop(attachment);
  for (const message of conversation.messages) if (message.role === "user") for (const attachment of message.attachments) attachmentText.drop(attachment);
}

/** Leaving a temporary conversation discards it with its draft and attachments. */
function leave(state: State, nextId: string): State {
  const current = state.conversations.find((conversation) => conversation.id === state.activeId);
  if (!current || current.id === nextId) return state;
  if (current.temporary || (!current.messages.length && !current.sample)) {
    const drafts = { ...state.drafts };
    const keepEmpty = !current.temporary && hasDraftContent(drafts[current.id]);
    if (!keepEmpty) dropAttachments(current, drafts[current.id]);
    if (!keepEmpty) delete drafts[current.id];
    return {
      ...state, drafts,
      conversations: keepEmpty ? state.conversations : state.conversations.filter((conversation) => conversation.id !== current.id),
    };
  }
  return state;
}

export function hasDraftContent(draft: Draft | undefined) {
  return Boolean(draft && (draft.text.trim() || draft.quotes.length || draft.attachments.length));
}

function reducer(state: State, action: ActionType): State {
  switch (action.type) {
    case "settings": return { ...state, settings: { ...state.settings, ...action.patch } };
    case "view": {
      if (action.view === state.view) return state;
      // Leaving the conversation ends a voice session; its captions return to the conversation.
      return { ...state, view: action.view, lastLearnView: action.view === "chat" ? state.lastLearnView : action.view, miniOpen: action.view === "chat" ? false : state.miniOpen, voiceOpen: action.view === "chat" ? state.voiceOpen : false };
    }
    case "mini": return { ...state, miniOpen: action.open };
    case "settings-open": return { ...state, settingsOpen: action.section };
    // Voice takes over the conversation area, so opening it from a learning page goes to the conversation.
    case "voice-open": return action.open ? { ...state, voiceOpen: true, view: "chat", miniOpen: false } : { ...state, voiceOpen: false };
    case "new": {
      const fresh = action.conversation;
      const current = state.conversations.find((conversation) => conversation.id === state.activeId);
      if (current && !current.messages.length && current.temporary === fresh.temporary && !hasDraftContent(state.drafts[current.id])) return state;
      const left = leave(state, fresh.id);
      return {
        ...left, conversations: [fresh, ...left.conversations], activeId: fresh.id, returnToId: null,
        drafts: { ...left.drafts, [fresh.id]: emptyDraft(state.settings) },
        announcement: fresh.temporary ? "已开始临时对话，内容不会保存" : "已开始新对话",
      };
    }
    case "select": {
      if (action.id === state.activeId || !state.conversations.some((conversation) => conversation.id === action.id)) return state;
      const previous = state.conversations.find((conversation) => conversation.id === state.activeId);
      const left = leave(state, action.id);
      return {
        ...left, activeId: action.id, returnToId: previous && previous.messages.length && !previous.temporary ? previous.id : null,
        drafts: left.drafts[action.id] ? left.drafts : { ...left.drafts, [action.id]: emptyDraft(state.settings) },
      };
    }
    case "delete": {
      const removed = state.conversations.find((conversation) => conversation.id === action.id);
      if (removed) dropAttachments(removed, state.drafts[removed.id]);
      const conversations = state.conversations.filter((conversation) => conversation.id !== action.id);
      const drafts = { ...state.drafts };
      delete drafts[action.id];
      if (action.id !== state.activeId) return { ...state, conversations, drafts, returnToId: state.returnToId === action.id ? null : state.returnToId };
      const fresh = action.fresh;
      return { ...state, conversations: [fresh, ...conversations], drafts: { ...drafts, [fresh.id]: emptyDraft(state.settings) }, activeId: fresh.id, returnToId: null };
    }
    case "clear-all": {
      // Bumping the generation drops any answer still streaming into a removed conversation.
      const keep = state.conversations.filter((conversation) => conversation.temporary && conversation.id === state.activeId);
      for (const conversation of state.conversations) if (!keep.includes(conversation)) dropAttachments(conversation, state.drafts[conversation.id]);
      const fresh = keep[0] ?? action.fresh;
      return {
        ...state, conversations: [fresh], activeId: fresh.id, returnToId: null, generation: state.generation + 1,
        drafts: { [fresh.id]: keep[0] ? state.drafts[fresh.id] ?? emptyDraft(state.settings) : emptyDraft(state.settings) }, notices: {},
        practice: state.practice ? { ...state.practice, convId: keep[0]?.id === state.practice.convId ? state.practice.convId : null } : null,
        announcement: "已清除普通对话",
      };
    }
    case "draft": {
      const draft = state.drafts[action.id];
      if (!draft) return state;
      const patch = typeof action.patch === "function" ? action.patch(draft) : action.patch;
      return { ...state, drafts: { ...state.drafts, [action.id]: { ...draft, ...patch } } };
    }
    case "notice": return { ...state, notices: { ...state.notices, [action.id]: action.notice } };
    case "append":
      return patchConversation(state, action.id, (conversation) => ({
        ...conversation, messages: [...conversation.messages, ...action.messages], updatedAt: Date.now(),
        title: conversation.messages.length || !action.title ? conversation.title : action.title,
      }));
    case "reveal":
      if (action.generation !== state.generation) return state;
      return patchConversation(state, action.id, (conversation) => ({
        ...conversation,
        messages: conversation.messages.map((message) => message.id === action.messageId && message.role === "assistant" && message.status === "streaming" ? { ...message, revealed: action.revealed } : message),
      }));
    case "finish":
      if (action.generation !== state.generation) return state;
      return patchConversation(state, action.id, (conversation) => ({
        ...conversation,
        messages: conversation.messages.map((message) => {
          if (message.id !== action.messageId || message.role !== "assistant" || message.status !== "streaming") return message;
          if (action.status === "done") return { ...message, status: "done", revealed: streamLength(message.blocks) };
          const remainder = action.status === "incomplete" ? remainderBlocks(message.blocks, message.revealed) : undefined;
          return { ...message, status: action.status, blocks: truncateBlocks(message.blocks, message.revealed), ...(remainder ? { remainder } : {}) };
        }),
      }));
    case "conversation-model":
      return patchConversation(state, action.id, (conversation) => ({ ...conversation, model: action.model }));
    case "drop-remainder":
      return patchConversation(state, action.id, (conversation) => ({
        ...conversation,
        messages: conversation.messages.map((message) => message.id === action.messageId && message.role === "assistant" ? { ...message, remainder: undefined } : message),
      }));
    case "block":
      return patchConversation(state, action.id, (conversation) => ({
        ...conversation,
        messages: conversation.messages.map((message) => message.id === action.messageId && message.role === "assistant"
          ? { ...message, blocks: message.blocks.map((block, index) => index === action.index ? action.block : block) } : message),
      }));
    case "practice": return { ...state, practice: action.session };
    case "announce": return { ...state, announcement: action.text };
    case "focus-composer": return { ...state, focusNonce: state.focusNonce + 1 };
  }
}

export type SendOptions = {
  text?: string; quotes?: Quote[]; action?: SelectionAction;
  /** A fallback the learner chose after a refusal; applies to this message only. */
  fallback?: Fallback;
  /** Sends without touching the draft (suggestions, toolbar actions). */
  keepDraft?: boolean; via?: "text" | "action" | "voice"; result?: PracticeResult; articleAvailable?: boolean;
};
export type SendOutcome = { ok: true; blocks: Block[]; label: string } | { ok: false; reason: "empty" | "reading" | "blocked" | "missing" };

type Store = {
  state: State;
  active: Conversation;
  draft: Draft;
  dispatch: (action: ActionType) => void;
  send: (conversationId: string, options?: SendOptions) => SendOutcome;
  stop: (conversationId: string) => void;
  setView: (view: View) => void;
  openChat: (conversationId?: string) => void;
  startPractice: (items: PracticeItem[], title: string, source: string, origin: PracticeSession["origin"]) => void;
  returnResult: () => void;
  appendVoice: (conversationId: string, captions: Caption[], seconds: number, blocks: Block[], request: RequestPayload | null, routeReason: string) => void;
  articleAvailable: (conversation: Conversation, draft: Draft) => boolean;
  newConversation: (temporary: boolean) => void;
  remove: (conversationId: string) => void;
  clearAll: () => void;
  continueReply: (conversationId: string, messageId: string) => void;
  /** The latest state, including actions dispatched in this tick; for async callbacks. */
  getState: () => State;
};

const StoreContext = createContext<Store | null>(null);

export function useStore() {
  const store = useContext(StoreContext);
  if (!store) throw new Error("StoreProvider missing");
  return store;
}

export function StoreProvider({ children }: { children: ReactNode }) {
  const [state, reactDispatch] = useReducer(reducer, undefined, initialState);
  const stateRef = useRef(state);
  const timers = useRef(new Map<string, ReturnType<typeof setInterval>>());
  // The reducer is pure and every id is created before dispatch, so applying an action to the ref
  // here gives callbacks the state React will render, without waiting for a commit.
  const dispatch = useCallback((action: ActionType) => {
    stateRef.current = reducer(stateRef.current, action);
    reactDispatch(action);
  }, []);

  useEffect(() => { writeStorage(`${STORAGE_KEY}:settings`, JSON.stringify(state.settings)); }, [state.settings]);
  useEffect(() => {
    if (state.conversations.some((conversation) => conversation.messages.some((message) => message.role === "assistant" && message.status === "streaming"))) return;
    writeStorage(STORAGE_KEY, serializeConversations(state.conversations));
  }, [state.conversations]);
  useEffect(() => {
    const ticking = timers.current;
    return () => { for (const timer of ticking.values()) clearInterval(timer); ticking.clear(); };
  }, []);
  useEffect(() => {
    const target = state.view;
    if (window.location.hash.slice(1) !== target) window.location.hash = target;
  }, [state.view]);
  useEffect(() => {
    const onHash = () => {
      const name = window.location.hash.slice(1);
      const view = (["today", "words", "reading", "records", "dictation", "chat"] as const).find((item) => item === name);
      if (view) dispatch({ type: "view", view });
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, [dispatch]);

  const articleAvailable = useCallback((conversation: Conversation, draft: Draft) => {
    const current = stateRef.current;
    const onReading = current.view === "reading" || (current.view === "chat" && current.lastLearnView === "reading");
    return onReading || draft.quotes.length > 0 || conversation.messages.some((message) => message.role === "user" && message.quotes.length > 0);
  }, []);

  const stream = useCallback((conversationId: string, message: AssistantMessage, truncate: boolean, after?: () => void) => {
    const total = streamLength(message.blocks);
    const limit = truncate ? Math.max(1, Math.floor(total * 0.55)) : total;
    const generation = stateRef.current.generation;
    const step = Math.max(3, Math.ceil(total / 28));
    let revealed = 0;
    const timer = setInterval(() => {
      revealed = Math.min(limit, revealed + step);
      dispatch({ type: "reveal", id: conversationId, messageId: message.id, revealed, generation });
      if (revealed >= limit) {
        clearInterval(timer);
        timers.current.delete(message.id);
        dispatch({ type: "finish", id: conversationId, messageId: message.id, status: truncate ? "incomplete" : "done", generation });
        dispatch({ type: "announce", text: truncate ? "回答未完整" : "回答完成" });
        after?.();
      }
    }, 28);
    timers.current.set(message.id, timer);
  }, [dispatch]);

  const send = useCallback((conversationId: string, options: SendOptions = {}): SendOutcome => {
    const current = stateRef.current;
    const conversation = current.conversations.find((item) => item.id === conversationId);
    const draft = current.drafts[conversationId];
    if (!conversation || !draft) return { ok: false, reason: "missing" };
    const busy = conversation.messages.some((message) => message.role === "assistant" && message.status === "streaming");
    if (busy) return { ok: false, reason: "blocked" };
    const text = (options.text ?? draft.text).trim();
    const quotes = options.quotes ?? (options.keepDraft ? [] : draft.quotes);
    const attachments = options.keepDraft ? [] : draft.attachments;
    if (!text && !quotes.length && !attachments.length && !options.result) return { ok: false, reason: "empty" };
    if (attachments.some((attachment) => attachment.status === "reading")) {
      dispatch({ type: "notice", id: conversationId, notice: { message: "还有附件在读取，读取完成后再发送。", alternatives: [] } });
      return { ok: false, reason: "reading" };
    }
    const classification = classifyTask({ text, action: options.action, hasQuote: quotes.length > 0, practiceResult: Boolean(options.result) });
    // Feedback on a returned result follows the route preference, never a pending one-message choice.
    const decided = resolveRoute(classification, { conversation: conversation.model, preference: current.settings.routePreference }, routeTable(current.settings.complexPlanTier));
    const route = options.fallback ? applyFallback(decided, options.fallback) : decided;
    const check = checkSendable(route, current.settings.service);
    if (!check.ok) {
      // A refused send keeps the draft and the one-message choice; nothing is sent or retried.
      dispatch({ type: "notice", id: conversationId, notice: { message: check.message, alternatives: check.alternatives } });
      return { ok: false, reason: "blocked" };
    }
    const available = options.articleAvailable ?? articleAvailable(conversation, draft);
    const article = available ? (draft.includeArticle ? "full" : "off") : "none";
    const readFiles = attachments.filter((item) => item.status === "read").map((item) => ({ name: item.name, chars: item.chars ?? 0 }));
    const attachmentsOnly = attachments.filter((item) => item.status === "attached").map((item) => ({ name: item.name, kind: item.kind }));
    const request = buildRequest(route, {
      records: draft.includeRecords, article, quotes: quotes.length, quoteChars: quotes.reduce((sum, quote) => sum + quote.text.length, 0), readFiles, attachmentsOnly,
    });
    const blocks = respond({
      route, text, quotes, includeRecords: draft.includeRecords, article, settings: current.settings, result: options.result,
      attachments: attachments.map((item) => ({ ...item, content: attachmentText.get(item.id) })),
    });
    const now = Date.now();
    const userMessage: Message[] = options.result ? [] : [{
      id: newId("u"), role: "user", at: now, text, quotes, attachments, via: options.via ?? (options.action ? "action" : "text"), action: options.action,
    }];
    const reply: AssistantMessage = { id: newId("a"), role: "assistant", at: now, status: "streaming", blocks, revealed: 0, request, routeReason: route.reason };
    const titleSource = text || (quotes[0] ? `${quotes[0].title} ${paragraphLabel(quotes[0])}` : attachments[0]?.name ?? "新对话");
    const title = options.action ? `${{ translate: "翻译", define: "词义", grammar: "语法" }[options.action]} · ${quotes[0] ? `${quotes[0].title} ${paragraphLabel(quotes[0])}` : ""}` : titleSource.slice(0, 22);
    dispatch({ type: "append", id: conversationId, messages: [...userMessage, reply], title });
    dispatch({ type: "notice", id: conversationId, notice: undefined });
    const carried = quotes.slice(0, 1).map((quote) => ({ ...quote, carried: true }));
    dispatch({
      type: "draft", id: conversationId,
      patch: (latest) => options.keepDraft
        // The draft stays as typed; a quote just answered is kept for a follow-up unless one is already there.
        ? { quotes: latest.quotes.length || !carried.length ? latest.quotes : carried }
        : { text: "", attachments: [], quotes: carried },
    });
    const truncate = current.settings.service === "truncate-next";
    if (truncate) dispatch({ type: "settings", patch: { service: "normal" } });
    stream(conversationId, reply, truncate);
    return { ok: true, blocks, label: requestLabel(route.model, route.effort) };
  }, [articleAvailable, dispatch, stream]);

  const stop = useCallback((conversationId: string) => {
    const conversation = stateRef.current.conversations.find((item) => item.id === conversationId);
    const streaming = conversation?.messages.find((message) => message.role === "assistant" && message.status === "streaming");
    if (!streaming) return;
    const timer = timers.current.get(streaming.id);
    if (timer) clearInterval(timer);
    timers.current.delete(streaming.id);
    dispatch({ type: "finish", id: conversationId, messageId: streaming.id, status: "stopped", generation: stateRef.current.generation });
    dispatch({ type: "announce", text: "已停止回答" });
  }, [dispatch]);

  const setView = useCallback((view: View) => dispatch({ type: "view", view }), [dispatch]);
  const newConversation = useCallback((temporary: boolean) => dispatch({ type: "new", conversation: blankConversation(temporary) }), [dispatch]);
  const remove = useCallback((conversationId: string) => {
    const timer = [...timers.current.entries()];
    const conversation = stateRef.current.conversations.find((item) => item.id === conversationId);
    for (const [messageId, handle] of timer) {
      if (conversation?.messages.some((message) => message.id === messageId)) { clearInterval(handle); timers.current.delete(messageId); }
    }
    dispatch({ type: "delete", id: conversationId, fresh: blankConversation(false) });
  }, [dispatch]);
  const clearAll = useCallback(() => dispatch({ type: "clear-all", fresh: blankConversation(false) }), [dispatch]);
  const getState = useCallback(() => stateRef.current, []);
  const continueReply = useCallback((conversationId: string, messageId: string) => {
    const current = stateRef.current;
    const conversation = current.conversations.find((item) => item.id === conversationId);
    const source = conversation?.messages.find((message): message is AssistantMessage => message.id === messageId && message.role === "assistant");
    if (!conversation || !source?.remainder || conversation.messages.some((message) => message.role === "assistant" && message.status === "streaming")) return;
    // The continuation repeats the original request's model and effort.
    const base = resolveRoute({ task: source.request.metadata.task, signals: [] }, { preference: "auto" }, routeTable(current.settings.complexPlanTier));
    const route = { ...base, model: source.request.model, effort: source.request.reasoning.effort };
    const check = checkSendable(route, current.settings.service);
    if (!check.ok) { dispatch({ type: "notice", id: conversationId, notice: { message: check.message, alternatives: [] } }); return; }
    const reply: AssistantMessage = {
      id: newId("a"), role: "assistant", at: Date.now(), status: "streaming", blocks: source.remainder, revealed: 0,
      request: source.request,
      routeReason: "继续上一条：你手动发起的第二次请求",
    };
    dispatch({ type: "drop-remainder", id: conversationId, messageId });
    dispatch({ type: "append", id: conversationId, messages: [reply] });
    stream(conversationId, reply, false);
  }, [dispatch, stream]);
  const openChat = useCallback((conversationId?: string) => {
    if (conversationId) dispatch({ type: "select", id: conversationId });
    dispatch({ type: "view", view: "chat" });
  }, [dispatch]);

  const startPractice = useCallback((items: PracticeItem[], title: string, source: string, origin: PracticeSession["origin"]) => {
    const current = stateRef.current;
    if (!items.length) return;
    dispatch({ type: "practice", session: { id: newId("practice"), convId: current.activeId, origin, title, source, items, rounds: [], current: [], index: 0, finished: false, returned: false } });
    dispatch({ type: "view", view: "dictation" });
    dispatch({ type: "mini", open: false });
  }, [dispatch]);

  const returnResult = useCallback(() => {
    const current = stateRef.current;
    const session = current.practice;
    if (!session || !session.rounds.length || session.returned) return;
    const result: PracticeResult = { title: session.title, source: session.source, rounds: session.rounds };
    const target = current.conversations.find((conversation) => conversation.id === session.convId);
    if (!target) dispatch({ type: "new", conversation: blankConversation(false) });
    else if (target.id !== current.activeId) dispatch({ type: "select", id: target.id });
    const conversationId = stateRef.current.activeId;
    const missing = !target;
    dispatch({ type: "append", id: conversationId, title: `听写结果 · ${session.title}`, messages: [{ id: newId("r"), role: "result", at: Date.now(), result }] });
    if (missing) {
      const notice: AssistantMessage = {
        id: newId("a"), role: "assistant", at: Date.now(), status: "done", revealed: 0, routeReason: "提示",
        request: buildRequest(resolveRoute({ task: "practice-feedback", signals: [] }, { preference: "auto" }, routeTable(current.settings.complexPlanTier)), { records: false, article: "none", quotes: 0, quoteChars: 0, readFiles: [], attachmentsOnly: [] }),
        blocks: [{ type: "notice", tone: "warn", text: "原来的对话已经不在了（临时对话会在离开时清除），结果放在这段新对话里。" }],
      };
      dispatch({ type: "append", id: conversationId, messages: [notice] });
    }
    dispatch({ type: "practice", session: { ...session, returned: true } });
    const outcome = send(conversationId, { result, keepDraft: true, text: "" });
    if (!outcome.ok) dispatch({ type: "announce", text: "结果已带回对话；反馈没有生成" });
    if (session.origin === "mini") dispatch({ type: "mini", open: true });
    else dispatch({ type: "view", view: "chat" });
  }, [dispatch, send]);

  const appendVoice = useCallback((conversationId: string, captions: Caption[], seconds: number, blocks: Block[], request: RequestPayload | null, routeReason: string) => {
    if (!captions.length || !stateRef.current.conversations.some((conversation) => conversation.id === conversationId)) return;
    const messages: Message[] = [{ id: newId("v"), role: "voice", at: Date.now(), captions, seconds }];
    if (blocks.length && request) messages.push({ id: newId("a"), role: "assistant", at: Date.now(), status: "done", revealed: 0, blocks, request, routeReason });
    dispatch({ type: "append", id: conversationId, messages, title: `语音 · ${captions.find((caption) => caption.speaker === "user")?.text.slice(0, 16) ?? "对话"}` });
  }, [dispatch]);

  const active = state.conversations.find((conversation) => conversation.id === state.activeId) ?? state.conversations[0];
  const draft = state.drafts[active.id] ?? emptyDraft(state.settings);
  const value = useMemo<Store>(() => ({
    state, active, draft, dispatch, send, stop, setView, openChat, startPractice, returnResult, appendVoice, articleAvailable, newConversation, remove, clearAll, getState, continueReply,
  }), [state, active, draft, dispatch, send, stop, setView, openChat, startPractice, returnResult, appendVoice, articleAvailable, newConversation, remove, clearAll, getState, continueReply]);
  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

export function planSteps(spec: PlanSpec) { return buildPlan(spec); }
export type { Attachment };
export { parseStoredConversations, serializeConversations };
