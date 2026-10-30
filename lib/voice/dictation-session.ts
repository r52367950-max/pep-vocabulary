import { NativeLiveSession, type VoiceSnapshot, type TranscriptTurn } from "./client";

/** Application-level dictation state. These events are not provider wire events. */
export type AnswerMode = "typed" | "spelled";
export type DictationAttempt = {
  id: string; itemId: string; answer: string; answerMode: AnswerMode;
  phase: "answering" | "capturing" | "confirming" | "submitted" | "revealed";
  heard: boolean; assisted: boolean; spellingConfirmed: boolean;
  commandId: string | null; captureId: string | null;
};
export function newDictationAttempt(id: string, itemId: string, answerMode: AnswerMode = "typed", assisted = false): DictationAttempt {
  return { id, itemId, answer: "", answerMode, phase: "answering", heard: false, assisted, spellingConfirmed: false, commandId: null, captureId: null };
}
export type DictationAttemptEvent = { attemptId: string } & (
  | { type: "play"; commandId: string }
  | { type: "heard"; commandId: string }
  | { type: "interrupt" }
  | { type: "edit"; answer: string }
  | { type: "mode"; mode: AnswerMode }
  | { type: "hint" }
  | { type: "reveal" }
  | { type: "capture"; captureId: string }
  | { type: "captured"; captureId: string; answer: string }
  | { type: "capture-failed"; captureId: string }
  | { type: "confirm" }
  | { type: "submit" }
);
export function canSubmitDictation(state: DictationAttempt): boolean {
  return state.phase === "answering" && state.heard && !!state.answer.trim()
    && (state.answerMode === "typed" || state.spellingConfirmed);
}
/** Identity and terminal-state checks make delayed callbacks and duplicate submits inert. */
export function reduceDictationAttempt(state: DictationAttempt, event: DictationAttemptEvent): DictationAttempt {
  if (event.attemptId !== state.id || state.phase === "submitted" || state.phase === "revealed") return state;
  switch (event.type) {
    case "play": return { ...state, commandId: event.commandId, captureId: null, phase: "answering" };
    case "heard": return event.commandId === state.commandId ? { ...state, heard: true } : state;
    case "interrupt": return { ...state, commandId: null, captureId: null, phase: state.phase === "capturing" ? "answering" : state.phase };
    case "edit": return state.phase === "capturing" ? state : { ...state, answer: event.answer.slice(0, 3000), spellingConfirmed: false, phase: state.answerMode === "spelled" ? "confirming" : "answering" };
    case "mode": return { ...state, answerMode: event.mode, spellingConfirmed: false, captureId: null, commandId: null, phase: event.mode === "spelled" && state.answer ? "confirming" : "answering" };
    case "hint": return { ...state, assisted: true };
    case "reveal": return { ...state, phase: "revealed", assisted: true, commandId: null, captureId: null };
    case "capture": return state.heard && state.answerMode === "spelled" ? { ...state, phase: "capturing", captureId: event.captureId, commandId: null, answer: "", spellingConfirmed: false } : state;
    case "captured": return state.phase === "capturing" && event.captureId === state.captureId ? { ...state, answer: event.answer.slice(0, 3000), phase: "confirming", captureId: null, spellingConfirmed: false } : state;
    case "capture-failed": return event.captureId === state.captureId ? { ...state, phase: "answering", captureId: null } : state;
    case "confirm": return state.phase === "confirming" && state.answer.trim() ? { ...state, phase: "answering", spellingConfirmed: true } : state;
    case "submit": return canSubmitDictation(state) ? { ...state, phase: "submitted", commandId: null, captureId: null } : state;
  }
}

/** Only explicit letters are joined. Homophones such as bee/see/are remain editable evidence. */
export function spellingDraft(transcript: string): { answer: string; uncertain: boolean } {
  const words = transcript.slice(0, 3000).normalize("NFKC").trim().split(/\bspace\b|空格/iu);
  const parsed = words.map((word) => {
    const letters = word.trim().split(/[\s,，.。\-–]+/u).filter(Boolean);
    return letters.length && letters.every((letter) => /^[a-z]$/i.test(letter)) ? letters.join("").toLowerCase() : null;
  });
  if (parsed.every((word) => word !== null)) return { answer: parsed.join(" "), uncertain: false };
  return { answer: transcript.slice(0, 3000).trim(), uncertain: true };
}

/** The capture adapter never receives the target text. Start must be an explicit user action. */
export type SpellingCaptureAdapter = {
  label: string;
  start(options: { signal: AbortSignal }): Promise<{ finish(): Promise<string>; cancel(): void }>;
};
export type DictationLearningPreferences = { preferredSpeed?: "normal" | "slow" };

export type DictationVoiceCommand = "repeat" | "slow" | "hint" | "stop";
/** Full utterance whitelist only; never execute a substring from arbitrary speech. */
export function dictationVoiceCommand(text: string): DictationVoiceCommand | null {
  const clean = text.normalize("NFKC").trim().toLowerCase().replace(/[.!?。！？，,]/g, "").replace(/\s+/g, " ");
  const commands: Record<string, DictationVoiceCommand> = {
    "重读": "repeat", "再读一遍": "repeat", "repeat": "repeat", "repeat please": "repeat",
    "慢速": "slow", "慢一点": "slow", "slower": "slow", "slow down": "slow",
    "提示": "hint", "给我提示": "hint", "hint": "hint", "hint please": "hint",
    "停": "stop", "停止": "stop", "stop": "stop",
  };
  return commands[clean] ?? null;
}

/** Live supplies fallible input transcription only. Fixed clips own question playback.
 * No target text is accepted here. Completion is an explicit user action, not a guessed wire event.
 */
export class DictationLiveInput {
  private transport: NativeLiveSession;
  private capture: { id: number; text: string; beginsAt: number } | null = null;
  private sequence = 0;
  private lastInputEnd = 0;
  private binding = "";
  private ready: { resolve(): void; reject(error: Error): void } | null = null;
  constructor(onState: (state: VoiceSnapshot, pendingClose: boolean) => void, factory = (callbacks: { onState: (state: VoiceSnapshot) => void; onTranscript: (turn: TranscriptTurn) => void }) => new NativeLiveSession(callbacks)) {
    this.transport = factory({
      onState: (state) => {
        if (state.phase === "connected") { this.ready?.resolve(); this.ready = null; }
        if (state.phase === "ended" || state.phase === "error") { this.ready?.reject(new Error(state.message)); this.ready = null; this.capture = null; }
        onState(state, this.transport?.hasPendingClose ?? false);
      },
      onTranscript: (turn) => {
        if (turn.role !== "user") return;
        // No provider turn IDs: reject un-timed/old segments instead of guessing ownership.
        if (!Number.isFinite(turn.startMs) || !Number.isFinite(turn.endMs) || turn.endMs! < turn.startMs!) return;
        this.lastInputEnd = Math.max(this.lastInputEnd, turn.endMs!);
        if (this.capture && turn.startMs! >= this.capture.beginsAt) this.capture.text = (this.capture.text + turn.text).slice(0, 3000);
      },
    });
  }
  get state() { return this.transport.state; }
  get pendingClose() { return this.transport.hasPendingClose; }
  async open(temporary: boolean, context?: { accountScope: string; contextRevision: number; contextVersion?: string }) {
    const binding = JSON.stringify({ temporary, ...context });
    if (this.state.phase === "connected") {
      if (binding === this.binding) return;
      await this.close();
      throw new Error("账户或学习记忆已改变，旧语音输入已停止，请重新开始。");
    }
    if (this.state.phase === "connecting" || this.state.phase === "closing") throw new Error("语音连接正在处理，请稍后再试。");
    if (this.pendingClose) throw new Error("上次语音尚未确认关闭，请先重试关闭。");
    const connected = new Promise<void>((resolve, reject) => { this.ready = { resolve, reject }; });
    // Handle a startup failure even when it is reported while start() is still resolving.
    const observed = connected.then(() => null, (error: Error) => error);
    this.lastInputEnd = 0;
    this.binding = binding;
    await this.transport.start({ topicId: "everyday", level: "B1", minutes: 5, purpose: "dictation", silentOutput: true, temporary, ...context });
    const error = await observed;
    if (error) throw error;
    this.transport.mute(true);
  }
  begin(signal: AbortSignal): { finish(): Promise<string>; cancel(): void } {
    if (signal.aborted || this.state.phase !== "connected") throw new Error("请先开启 Live 语音输入。");
    const id = ++this.sequence;
    this.capture = { id, text: "", beginsAt: Math.max(this.transport.elapsedMs, this.lastInputEnd + 1) };
    this.transport.mute(false);
    const cancel = () => { signal.removeEventListener("abort", cancel); if (this.capture?.id === id) { this.capture = null; this.transport.mute(true); } };
    signal.addEventListener("abort", cancel, { once: true });
    return {
      finish: async () => { const text = this.capture?.id === id ? this.capture.text : ""; cancel(); if (!text.trim()) throw new Error("还没有可确认的转写，请重新说一次或使用键盘。"); return text; },
      cancel,
    };
  }
  async close() {
    this.capture = null; this.sequence++;
    await this.transport.end("Live 语音输入已停止。");
    this.ready?.reject(new Error("已取消语音输入。")); this.ready = null;
  }
  retryClose() { return this.transport.retryClose(); }
  dispose() { this.capture = null; this.sequence++; this.ready?.reject(new Error("已离开语音输入。")); this.ready = null; this.transport.dispose(); }
}
