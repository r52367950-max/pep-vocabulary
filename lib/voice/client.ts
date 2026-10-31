import { readLocalPracticeData, writeLocalPracticeData, type PracticeGeneration } from "../local-practice-generation";

export type VoicePhase = "idle" | "connecting" | "connected" | "closing" | "ended" | "error";
export type VoiceStatus = { configured: boolean; ready: boolean; reason?: string; models: { voice: string; text: string }; dailySecondsLimit?: number; usedSeconds?: number; remainingSeconds?: number; resetsAt?: string; timeLimitNotice?: string; activeSession?: { sessionId: string; expiresAt: string } | null };
export type TranscriptTurn = { role: "user" | "assistant"; text: string; startMs?: number; endMs?: number };
export type VoiceFeedback = { strength: string; improvements: { original: string; suggestion: string; reason: string }[]; retryPrompt: string; expressions: { text: string; meaning: string }[] };
export type VoiceOptions = { topicId: string; level: string; minutes: number; diagnostic?: boolean; purpose?: "conversation" | "dictation"; silentOutput?: boolean; temporary?: boolean; contextRevision?: number; contextVersion?: string; accountScope?: string; targetWords?: string[]; customTopic?: string; goal?: string; openingPrompt?: string };
export type VoiceSnapshot = { phase: VoicePhase; message: string; muted: boolean; paused: boolean; playbackBlocked: boolean; seconds: number; usageSeconds: number | null; maxSeconds: number; closeConfirmed: boolean };
type VoiceEvent = { type?: string; delta?: string; start_ms?: number; end_ms?: number; event_id?: string; usage?: { seconds?: number }; error?: { message?: string }; session?: { id?: string } };
type SessionReply = { sessionId: string; sdp: string; model: string; maxSeconds: number };
type Dependencies = { fetch: typeof fetch; getUserMedia: (constraints: MediaStreamConstraints) => Promise<MediaStream>; createPeer: () => RTCPeerConnection; createAudio: () => HTMLAudioElement; createAudioContext: () => AudioContext; now: () => number };

export async function voiceRequest<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, { method: body === undefined ? "GET" : "POST", credentials: "same-origin", headers: body === undefined ? undefined : { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body), signal });
  const result = await response.json().catch(() => null);
  if (!response.ok) throw new Error(typeof result?.error === "string" ? result.error : result?.error?.message || `请求未完成（${response.status}）`);
  return result as T;
}

/** Native WebRTC transport. No keys, media recordings, SDK, or automatic reconnection. */
export class NativeLiveSession {
  private generation = 0;
  private peer?: RTCPeerConnection;
  private channel?: RTCDataChannel;
  private stream?: MediaStream;
  private audio?: HTMLAudioElement;
  private diagnosticContext?: AudioContext;
  private diagnostic = false;
  private silentOutput = false;
  private dictation = false;
  private pendingCloseIds = new Set<string>();
  private abort?: AbortController;
  private sessionId?: string;
  private startupTimer?: ReturnType<typeof setTimeout>;
  private closeTimer?: ReturnType<typeof setTimeout>;
  private clock?: ReturnType<typeof setInterval>;
  private startedAt = 0;
  private closedResolve?: () => void;
  private endPromise?: Promise<void>;
  private snapshot: VoiceSnapshot = { phase: "idle", message: "准备好就开始", muted: false, paused: false, playbackBlocked: false, seconds: 0, usageSeconds: null, maxSeconds: 600, closeConfirmed: false };
  private deps: Dependencies;
  constructor(private callbacks: { onState: (state: VoiceSnapshot) => void; onTranscript: (turn: TranscriptTurn) => void }, dependencies?: Partial<Dependencies>) {
    this.deps = { fetch: (...args) => fetch(...args), getUserMedia: (constraints) => navigator.mediaDevices.getUserMedia(constraints), createPeer: () => new RTCPeerConnection(), createAudio: () => new Audio(), createAudioContext: () => new AudioContext(), now: () => Date.now(), ...dependencies };
  }
  get state() { return { ...this.snapshot }; }
  get elapsedMs() { return this.snapshot.phase === "connected" ? Math.max(0, this.deps.now() - this.startedAt) : 0; }
  private update(patch: Partial<VoiceSnapshot>) { this.snapshot = { ...this.snapshot, ...patch }; this.callbacks.onState(this.state); }
  private send(event: object) { if (this.channel?.readyState === "open") { this.channel.send(JSON.stringify({ ...event, event_id: crypto.randomUUID() })); return true; } return false; }
  private stopCapture() { this.stream?.getTracks().forEach((track) => track.stop()); this.stream = undefined; }
  private cleanup() {
    clearTimeout(this.startupTimer); clearTimeout(this.closeTimer); clearInterval(this.clock);
    this.stopCapture();
    if (this.diagnosticContext) { void this.diagnosticContext.close().catch(() => undefined); this.diagnosticContext = undefined; }
    if (this.channel) { this.channel.onmessage = null; this.channel.onclose = null; this.channel.close(); this.channel = undefined; }
    if (this.peer) { this.peer.ontrack = null; this.peer.onconnectionstatechange = null; this.peer.close(); this.peer = undefined; }
    if (this.audio) { this.audio.pause(); this.audio.srcObject = null; this.audio = undefined; }
  }
  get hasPendingClose() { return this.pendingCloseIds.size > 0; }
  async retryClose() {
    for (const id of [...this.pendingCloseIds]) await this.closeRemote(id);
    this.update({ closeConfirmed: !this.hasPendingClose, message: this.hasPendingClose ? "服务器尚未确认结束，请再次重试关闭。" : "语音会话已关闭。" });
  }
  private closeRemote(sessionId: string) {
    const previouslyPending = this.hasPendingClose;
    this.pendingCloseIds.add(sessionId);
    // Late startup answers may arrive after local cancellation, outside end().
    // Notify consumers whenever close availability changes, including that path.
    if (!previouslyPending) this.update({});
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 8_000);
    return this.deps.fetch("/api/voice/close", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sessionId }), keepalive: true, signal: abort.signal }).then((response) => {
      const previouslyPending = this.hasPendingClose;
      if (response.ok) this.pendingCloseIds.delete(sessionId);
      if (previouslyPending !== this.hasPendingClose) this.update({});
      return response.ok;
    }).catch(() => false).finally(() => clearTimeout(timer));
  }
  async start(options: VoiceOptions) {
    if (["connecting", "connected", "closing"].includes(this.snapshot.phase)) return;
    if (this.hasPendingClose) { this.update({ message: "上次语音尚未确认关闭，请先重试关闭。" }); return; }
    const generation = ++this.generation;
    const current = () => generation === this.generation;
    this.endPromise = undefined;
    this.diagnostic = options.diagnostic === true;
    this.dictation = options.purpose === "dictation";
    this.silentOutput = options.silentOutput === true || this.dictation;
    this.update({ phase: "connecting", message: this.diagnostic ? "正在准备无麦克风连接测试…" : "正在请求麦克风…", seconds: 0, usageSeconds: null, muted: false, paused: false, playbackBlocked: false, closeConfirmed: false, maxSeconds: this.diagnostic ? 20 : options.minutes * 60 });
    this.abort = new AbortController();
    this.startupTimer = setTimeout(() => { if (current() && this.snapshot.phase === "connecting") void this.end("连接超时，请检查网络后重新开始。", true); }, 35_000);
    try {
      let stream: MediaStream;
      if (this.diagnostic) {
        const context = this.deps.createAudioContext(); this.diagnosticContext = context;
        await context.resume();
        if (!current()) { if (context.state !== "closed") void context.close().catch(() => undefined); return; }
        stream = context.createMediaStreamDestination().stream;
      } else {
        stream = await this.deps.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
      }
      if (!current()) { stream.getTracks().forEach((track) => track.stop()); return; }
      this.stream = stream;
      const peer = this.deps.createPeer(); this.peer = peer;
      const audio = this.deps.createAudio(); this.audio = audio; audio.autoplay = true; audio.muted = this.silentOutput;
      audio.setAttribute("playsinline", "");
      peer.ontrack = (event) => { if (!current()) return; audio.srcObject = event.streams[0] || new MediaStream([event.track]); void this.resumePlayback(); };
      for (const track of stream.getAudioTracks()) peer.addTrack(track, stream);
      const channel = peer.createDataChannel("oai-events"); this.channel = channel;
      channel.onmessage = ({ data }) => { if (!current()) return; try { this.handleEvent(JSON.parse(data)); } catch { /* Ignore malformed transport events. */ } };
      channel.onclose = () => { if (current() && this.snapshot.phase === "connected") void this.end("连接中断，已停止麦克风。可手动重新开始。", true); };
      peer.onconnectionstatechange = () => { if (current() && peer.connectionState === "failed") void this.end("语音连接失败，已停止麦克风。", true); };
      await peer.setLocalDescription(await peer.createOffer());
      await this.waitForIce(peer, this.abort.signal);
      if (!current()) return;
      const sdp = peer.localDescription?.sdp;
      if (!sdp) throw new Error("浏览器未能建立语音连接。");
      this.update({ message: "正在建立语音连接…" });
      const response = await this.deps.fetch("/api/voice/session", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...options, sdp }), signal: this.abort.signal });
      const result = await response.json() as SessionReply & { error?: string | { message?: string } };
      if (!response.ok) throw new Error(typeof result.error === "string" ? result.error : result.error?.message || "语音服务暂时无法连接。");
      if (!result.sessionId || !result.sdp) throw new Error("语音服务返回了不完整的连接信息。");
      if (!current()) { void this.closeRemote(result.sessionId); return; }
      this.sessionId = result.sessionId;
      this.update({ maxSeconds: Math.min(this.diagnostic ? 20 : options.minutes * 60, Number.isFinite(result.maxSeconds) && result.maxSeconds > 0 ? result.maxSeconds : options.minutes * 60) });
      await peer.setRemoteDescription({ type: "answer", sdp: result.sdp });
    } catch (error) {
      if (!current()) return;
      const name = error instanceof Error ? error.name : "";
      const message = name === "NotAllowedError" ? "麦克风权限未开启。请在浏览器设置中允许，再重新开始。" : name === "NotFoundError" ? "没有找到麦克风。你仍可以使用听写练习。" : error instanceof Error ? error.message : "语音连接失败。";
      await this.end(message, true);
    }
  }
  private waitForIce(peer: RTCPeerConnection, signal: AbortSignal) {
    if (signal.aborted) return Promise.reject(new Error("连接已取消"));
    if (peer.iceGatheringState === "complete") return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const finish = (error?: Error) => { clearTimeout(timer); peer.removeEventListener("icegatheringstatechange", check); signal.removeEventListener("abort", cancelled); if (error) reject(error); else resolve(); };
      const check = () => { if (peer.iceGatheringState === "complete") finish(); };
      const cancelled = () => finish(new Error("连接已取消"));
      const timer = setTimeout(() => finish(new Error("网络连接准备超时。")), 10_000);
      peer.addEventListener("icegatheringstatechange", check); signal.addEventListener("abort", cancelled, { once: true }); check();
    });
  }
  private handleEvent(event: VoiceEvent) {
    if (event.type === "session.started" && this.snapshot.phase === "connecting") {
      clearTimeout(this.startupTimer); this.startedAt = this.deps.now();
      this.update({ phase: "connected", message: this.diagnostic ? "Live 已连接，正在等待测试语音；20 秒后自动结束。" : "已连接，慢慢说，我在听。" });
      this.clock = setInterval(() => { const seconds = Math.max(0, Math.floor((this.deps.now() - this.startedAt) / 1000)); this.update({ seconds }); if (seconds >= this.snapshot.maxSeconds) void this.end(this.diagnostic ? "连接测试已结束。" : "本次练习时间到了，语音已结束。"); }, 500);
      if (!this.dictation) this.send({ type: "session.commentary.append", delegation_id: null, content: this.diagnostic ? "Say this short test sentence aloud: Hello! Your English speaking practice is ready. Then remain silent." : "Greet the learner briefly in English, ask one opening question about the selected topic, then pause and listen. Give them time to think." });
    } else if ((event.type === "session.input_transcript.delta" || event.type === "session.output_transcript.delta") && typeof event.delta === "string") {
      if (this.dictation && event.type === "session.output_transcript.delta") return;
      this.callbacks.onTranscript({ role: event.type === "session.input_transcript.delta" ? "user" : "assistant", text: event.delta, startMs: event.start_ms, endMs: event.end_ms });
    } else if (event.type === "session.usage.updated") {
      if (typeof event.usage?.seconds === "number") this.update({ usageSeconds: event.usage.seconds });
    } else if (event.type === "session.closed") {
      this.update({ usageSeconds: event.usage?.seconds ?? this.snapshot.usageSeconds, closeConfirmed: true });
      if (this.closedResolve) this.closedResolve();
      else {
        const sessionId = this.sessionId;
        const generation = ++this.generation; this.cleanup(); this.sessionId = undefined;
        // The provider can end a session independently. Release the application's
        // ownership lease too, so a completed call does not block the next one.
        if (sessionId) {
          this.update({ phase: "closing", message: "语音已结束，正在整理会话状态…" });
          this.endPromise = this.closeRemote(sessionId).then((released) => {
            if (this.generation === generation) this.update({ phase: "ended", message: released ? "语音练习已结束。" : "语音已结束，会话状态尚未同步；请重试关闭上次语音。" });
          });
        } else this.update({ phase: "ended", message: "语音练习已结束。" });
      }
    } else if (event.type === "error") this.update({ message: "语音服务未能处理操作。可以结束后重试。" });
  }
  mute(muted: boolean) {
    if (this.snapshot.phase !== "connected") return;
    this.stream?.getAudioTracks().forEach((track) => { track.enabled = !muted; });
    this.send({ type: muted ? "session.input_audio.mute" : "session.input_audio.unmute" });
    this.update({ muted, message: muted ? "麦克风已静音；会话仍在计时。" : "麦克风已开启。" });
  }
  pause(paused: boolean) {
    if (this.snapshot.phase !== "connected") return;
    if (this.audio) this.audio.muted = this.silentOutput || paused;
    this.send({ type: "session.instructions.append", delegation_id: null, content: paused ? "Stop speaking now. The learner is thinking. Stay quiet until they explicitly ask to continue. Do not fill the silence." : "The learner is ready to continue. Resume the English practice gently, keeping your reply brief and listening patiently." });
    this.update({ paused, message: paused ? "AI 播放已暂停，留点时间想一想；会话仍在计时。" : "继续对话。" });
  }
  async resumePlayback() {
    const audio = this.audio;
    if (!audio) return;
    if (this.silentOutput) audio.muted = true;
    try { await audio.play(); if (this.audio === audio) this.update({ playbackBlocked: false }); }
    catch { if (this.audio === audio) this.update({ playbackBlocked: true }); }
  }
  end(message = "本机语音已停止。可以检查转写，再获取文字反馈。", failed = false) {
    if (this.endPromise) return this.endPromise;
    if (!["connecting", "connected"].includes(this.snapshot.phase)) return Promise.resolve();
    this.stopCapture(); clearTimeout(this.startupTimer); clearInterval(this.clock); this.abort?.abort();
    if (this.audio) this.audio.muted = true;
    this.update({ phase: "closing", message: "正在结束语音…" });
    const endingGeneration = this.generation;
    this.endPromise = (async () => {
      if (this.channel?.readyState === "open") await new Promise<void>((resolve) => { this.closedResolve = resolve; this.closeTimer = setTimeout(resolve, 1500); this.send({ type: "session.close" }); });
      if (this.generation !== endingGeneration) return;
      const sessionId = this.sessionId;
      this.generation++; this.cleanup(); this.closedResolve = undefined; this.sessionId = undefined;
      // An authenticated server close also releases its lease and bounds remote cleanup.
      const finalGeneration = this.generation;
      if (sessionId) {
        const acknowledged = await this.closeRemote(sessionId);
        if (this.generation !== finalGeneration) return;
        if (acknowledged) this.update({ closeConfirmed: true });
      }
      this.update({ phase: failed ? "error" : "ended", message: sessionId && !this.snapshot.closeConfirmed ? `${message} 本机麦克风已停止，但服务器尚未确认结束；请重试关闭上次语音。` : message });
    })();
    return this.endPromise;
  }
  dispose() {
    const generation = ++this.generation; this.abort?.abort();
    this.send({ type: "session.close" });
    if (this.sessionId) void this.closeRemote(this.sessionId).then((confirmed) => { if (confirmed && this.generation === generation) this.update({ closeConfirmed: true }); });
    this.sessionId = undefined; this.closedResolve?.(); this.closedResolve = undefined; this.cleanup();
    this.update({ phase: "ended", message: "语音已停止。需要时可手动开始新的练习。" });
  }
}

/** Two independent caption streams; grouping is visual, never a claim of a completed turn. */
export function appendTranscript(turns: TranscriptTurn[], fragment: TranscriptTurn): TranscriptTurn[] {
  const copy = [...turns];
  let index = copy.length - 1;
  while (index >= 0 && copy[index].role !== fragment.role) index--;
  const previous = copy[index];
  let rest = fragment.text;
  if (previous && fragment.startMs !== undefined && previous.endMs !== undefined && fragment.startMs - previous.endMs < 2500 && fragment.startMs >= (previous.startMs ?? 0)) {
    const used = Math.min(rest.length, Math.max(0, 3000 - previous.text.length));
    copy[index] = { ...previous, text: previous.text + rest.slice(0, used), endMs: fragment.endMs };
    rest = rest.slice(used);
  }
  while (rest.length) { copy.push({ ...fragment, text: rest.slice(0, 3000) }); rest = rest.slice(3000); }
  return copy.slice(-150);
}

export type VoiceDiscussionTurn = { role: "user" | "assistant"; text: string };
export type VoiceRecord = { contextRevision?: number; id: string; createdAt: string; topicId: string; level: string; seconds: number; transcript: TranscriptTurn[]; feedback?: VoiceFeedback; discussion?: VoiceDiscussionTurn[]; customTopic?: string; goal?: string; openingPrompt?: string };
/** Bound the feedback request, leaving the complete local transcript available to the learner. */
export function feedbackTranscript(turns: TranscriptTurn[], maximum = 18000): TranscriptTurn[] {
  let remaining = maximum;
  const selected: TranscriptTurn[] = [];
  for (let index = turns.length - 1; index >= 0 && remaining > 0 && selected.length < 100; index--) {
    const turn = turns[index];
    const text = turn.text.slice(-Math.min(3000, remaining));
    if (!text.trim()) continue;
    selected.unshift({ role: turn.role, text }); remaining -= text.length;
  }
  return selected;
}
export const VOICE_HISTORY_KEY = "pep-vocab-voice-history-v1";
export function readVoiceHistory(storage: Pick<Storage, "getItem">): VoiceRecord[] {
  try {
    const rows: unknown = JSON.parse(storage.getItem(VOICE_HISTORY_KEY) || "[]");
    if (!Array.isArray(rows)) return [];
    return rows.filter((row): row is VoiceRecord => row && typeof row.id === "string" && typeof row.topicId === "string" && Array.isArray(row.transcript) && row.transcript.every((turn: TranscriptTurn) => turn && ["user", "assistant"].includes(turn.role) && typeof turn.text === "string")).slice(0, 12).map((row) => ({
      ...row,
      customTopic: typeof row.customTopic === "string" ? row.customTopic.slice(0, 500) : undefined,
      goal: typeof row.goal === "string" ? row.goal.slice(0, 500) : undefined,
      openingPrompt: typeof row.openingPrompt === "string" ? row.openingPrompt.slice(0, 500) : undefined,
      discussion: Array.isArray(row.discussion) ? row.discussion.filter((turn) => turn && ["user", "assistant"].includes(turn.role) && typeof turn.text === "string").slice(-20).map((turn) => ({ role: turn.role, text: turn.text.slice(0, 4000) })) : [],
    }));
  } catch { return []; }
}
export function saveVoiceRecord(storage: Pick<Storage, "getItem" | "setItem">, record: VoiceRecord) {
  const rows = [record, ...readVoiceHistory(storage).filter((item) => item.id !== record.id)].slice(0, 12);
  storage.setItem(VOICE_HISTORY_KEY, JSON.stringify(rows)); return rows;
}

export type LocalVoiceHistory = { scope: string; generation: PracticeGeneration; rows: VoiceRecord[] };
function scopedHistoryStorage(storage: Storage, scope: string) {
  return { getItem: (key: string) => storage.getItem(`${key}:${scope}`), setItem: (key: string, value: string) => storage.setItem(`${key}:${scope}`, value) };
}
export async function readLocalVoiceHistory(scope: string): Promise<LocalVoiceHistory> {
  const snapshot = await readLocalPracticeData((storage) => readVoiceHistory(scopedHistoryStorage(storage, scope)));
  return { scope, generation: snapshot.generation, rows: snapshot.value };
}
export function saveLocalVoiceRecord(snapshot: Pick<LocalVoiceHistory, "scope" | "generation">, record: VoiceRecord, allowed = () => true) {
  return writeLocalPracticeData(snapshot.generation, (storage) => {
    if (!allowed()) throw new Error("账户或学习模式已改变，请重新开始练习。");
    return saveVoiceRecord(scopedHistoryStorage(storage, snapshot.scope), record);
  });
}
export function deleteLocalVoiceRecord(snapshot: Pick<LocalVoiceHistory, "scope" | "generation">, recordId: string, allowed = () => true) {
  return writeLocalPracticeData(snapshot.generation, (storage) => {
    if (!allowed()) throw new Error("账户或学习模式已改变，请重新打开练习记录。");
    const scoped = scopedHistoryStorage(storage, snapshot.scope);
    const rows = readVoiceHistory(scoped).filter((row) => row.id !== recordId);
    scoped.setItem(VOICE_HISTORY_KEY, JSON.stringify(rows));
    return rows;
  });
}
