import { AssistantUpstreamError, mappedUpstreamFailure, readBoundedResponseText } from "../assistant/core";

export const VOICE_MODEL = "gpt-live-1";
export const SPEECH_MODEL = "gpt-audio-1.5";
const OPENAI_ORIGIN = "https://api.openai.com";

/** A fixed-host, bounded paid request. The timeout covers headers and the complete body. */
export async function voiceOpenAI(request: Request, apiKey: string, path: string, body: unknown, maximumBytes = 300_000, timeoutMs = 35_000): Promise<Record<string, unknown>> {
  if (!/^\/v1\/(?:live\/sessions(?:\/[A-Za-z0-9_-]+\/hangup)?|chat\/completions)$/.test(path)) throw new Error("Unsupported voice endpoint");
  const controller = new AbortController();
  const cancel = () => controller.abort();
  request.signal.addEventListener("abort", cancel, { once: true });
  if (request.signal.aborted) cancel();
  const timer = setTimeout(cancel, timeoutMs);
  try {
    controller.signal.throwIfAborted();
    const response = await fetch(`${OPENAI_ORIGIN}${path}`, {
      method: "POST", redirect: "manual", signal: controller.signal,
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) {
      let code: string | undefined, param: string | undefined;
      try {
        const failure = JSON.parse(await readBoundedResponseText(response, 4096, controller.signal));
        const safe = (value: unknown) => typeof value === "string" && /^[a-zA-Z0-9_.\[\]-]{1,100}$/.test(value) ? value : undefined;
        code = safe(failure?.error?.code); param = safe(failure?.error?.param);
      } catch { /* Preserve the status mapping without exposing arbitrary provider text. */ }
      console.error("voice-provider-failure", { status: response.status, code, param });
      if (code === "model_not_found" || code === "permission_denied") throw new AssistantUpstreamError("voice_model_unavailable", "当前 API 项目无权使用这个语音模型，或模型尚未向该项目开放。", 503, false, response.status);
      throw mappedUpstreamFailure(response.status);
    }
    const text = await readBoundedResponseText(response, maximumBytes, controller.signal);
    if (!text && path.endsWith("/hangup")) return {};
    try {
      const data: unknown = JSON.parse(text);
      if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error();
      return data as Record<string, unknown>;
    } catch { throw new AssistantUpstreamError("invalid_provider_response", "语音服务返回了无法识别的数据。", 502, true); }
  } catch (error) {
    if (request.signal.aborted) throw new AssistantUpstreamError("request_aborted", "请求已取消。", 499, false);
    if (error instanceof AssistantUpstreamError) throw error;
    if (controller.signal.aborted) throw new AssistantUpstreamError("upstream_timeout", "语音服务响应超时，请稍后重试。", 504, true);
    throw new AssistantUpstreamError("provider_unavailable", "语音服务暂时不可用，请稍后重试。", 502, true);
  } finally { clearTimeout(timer); request.signal.removeEventListener("abort", cancel); }
}

export function normalizedSpeechText(text: string) {
  return (text.normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu) ?? []).map((token) => token.replace(/’/g, "'")).join(" ");
}

/** Use the same token boundaries as transcript verification, with a floor for
 * long words, digit strings and unspaced non-ASCII prose. This is an admission
 * estimate; validated audio duration can only increase its charge. */
export function estimatedSpeechSeconds(text: string, rate: number) {
  const normalized = normalizedSpeechText(text);
  const tokens = normalized ? normalized.split(" ").length : 0;
  const characters = [...normalized.replace(/[\s']/g, "")].length;
  const expanded = (normalized.match(/\p{N}|[^\x00-\x7f]/gu) ?? []).length;
  return Math.max(4, Math.ceil(Math.max(tokens, Math.ceil(characters / 5), expanded) * 0.8 / rate));
}

/** Parse complete PCM/IEEE-float RIFF WAVs, including ancillary chunks. Unknown
 * or inconsistent formats retain the pre-request estimate; never guess a rate
 * from an untrusted header or let a truncated data chunk reduce accounting. */
export function speechDurationSeconds(bytes: Uint8Array): number | null {
  if (bytes.length < 44) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (offset: number) => String.fromCharCode(...bytes.subarray(offset, offset + 4));
  if (tag(0) !== "RIFF" || tag(8) !== "WAVE" || view.getUint32(4, true) + 8 !== bytes.length) return null;
  let byteRate = 0, blockAlign = 0, dataBytes = 0, chunks = 0;
  for (let offset = 12; offset < bytes.length;) {
    if (offset + 8 > bytes.length || ++chunks > 1000) return null;
    const kind = tag(offset), size = view.getUint32(offset + 4, true), start = offset + 8;
    const end = start + size, next = end + (size % 2);
    if (end > bytes.length || next > bytes.length) return null;
    if (kind === "fmt ") {
      if (byteRate || size < 16) return null;
      const format = view.getUint16(start, true), channels = view.getUint16(start + 2, true);
      const sampleRate = view.getUint32(start + 4, true), bits = view.getUint16(start + 14, true);
      byteRate = view.getUint32(start + 8, true); blockAlign = view.getUint16(start + 12, true);
      if (![1, 3].includes(format) || channels < 1 || channels > 8 || sampleRate < 8000 || sampleRate > 384000 ||
          !(format === 1 ? [8, 16, 24, 32] : [32, 64]).includes(bits) ||
          blockAlign !== channels * bits / 8 || byteRate !== sampleRate * blockAlign) return null;
    } else if (kind === "data") dataBytes += size;
    offset = next;
  }
  if (!byteRate || !dataBytes || dataBytes % blockAlign) return null;
  return Math.ceil(dataBytes / byteRate);
}

/** Never mark a different sentence as the requested dictation. */
export function speechAudio(payload: Record<string, unknown>, expected: string): Uint8Array {
  const choices = payload.choices as Array<{ message?: { audio?: { data?: unknown; transcript?: unknown } }; finish_reason?: unknown }> | undefined;
  const choice = choices?.[0];
  const audio = choice?.message?.audio;
  if (choice?.finish_reason === "length" || typeof audio?.data !== "string" || typeof audio.transcript !== "string" || !normalizedSpeechText(expected) || normalizedSpeechText(audio.transcript) !== normalizedSpeechText(expected)) {
    throw new AssistantUpstreamError("speech_text_mismatch", "生成的音频与听写原文不一致，请重试或使用设备朗读。", 502, true);
  }
  if (audio.data.length > 4_000_000 || !/^[A-Za-z0-9+/]*={0,2}$/.test(audio.data)) throw new AssistantUpstreamError("invalid_provider_response", "语音服务返回的音频无效。", 502, true);
  let bytes: Uint8Array;
  try { bytes = Uint8Array.from(atob(audio.data), (char) => char.charCodeAt(0)); }
  catch { throw new AssistantUpstreamError("invalid_provider_response", "语音服务返回的音频无效。", 502, true); }
  // The requested format is WAV. Reject JSON, empty bodies and other unexpected bytes.
  if (bytes.length < 44 || String.fromCharCode(...bytes.slice(0, 4)) !== "RIFF" || String.fromCharCode(...bytes.slice(8, 12)) !== "WAVE") throw new AssistantUpstreamError("invalid_provider_response", "语音服务返回的音频无效。", 502, true);
  return bytes;
}

/** WebRTC termination uses the documented sideband command, not the SIP hangup API. */
export async function closeOpenAISession(request: Request, apiKey: string, sessionId: string, timeoutMs = 15_000): Promise<void> {
  if (!/^[A-Za-z0-9_-]{4,200}$/.test(sessionId)) throw new Error("Invalid session identifier");
  type ControlSocket = {
    accept(): void; send(data: string): void; close(code?: number, reason?: string): void;
    addEventListener(type: string, listener: (event: MessageEvent) => void): void;
    removeEventListener(type: string, listener: (event: MessageEvent) => void): void;
  };
  const controller = new AbortController();
  const cancel = () => controller.abort();
  request.signal.addEventListener("abort", cancel, { once: true });
  if (request.signal.aborted) cancel();
  const timer = setTimeout(cancel, timeoutMs);
  let socket: ControlSocket | undefined;
  try {
    controller.signal.throwIfAborted();
    const response = await fetch(`${OPENAI_ORIGIN}/v1/live/sessions/${sessionId}/attach`, {
      method: "GET", redirect: "manual", signal: controller.signal,
      headers: { authorization: `Bearer ${apiKey}`, upgrade: "websocket" },
    });
    if (response.status !== 101) { void response.body?.cancel().catch(() => undefined); throw mappedUpstreamFailure(response.status); }
    socket = (response as unknown as { webSocket?: ControlSocket }).webSocket;
    if (!socket) throw new AssistantUpstreamError("voice_close_unconfirmed", "没有建立关闭控制连接，请重试结束会话。", 502, true);
    const control = socket;
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        controller.signal.removeEventListener("abort", aborted);
        control.removeEventListener("message", message);
        control.removeEventListener("error", failed);
        control.removeEventListener("close", failed);
      };
      const finish = (error?: Error) => { cleanup(); if (error) reject(error); else resolve(); };
      const aborted = () => finish(new DOMException("Aborted", "AbortError"));
      const failed = () => finish(new AssistantUpstreamError("voice_close_unconfirmed", "会话结束状态尚未确认，请重试结束会话。", 502, true));
      const message = (event: MessageEvent) => {
        if (typeof event.data !== "string" || event.data.length > 100_000) return;
        let data: { type?: unknown };
        try { data = JSON.parse(event.data); } catch { return; }
        if (data?.type === "session.closed") finish();
        if (data?.type === "error") failed();
      };
      control.addEventListener("message", message);
      control.addEventListener("error", failed);
      control.addEventListener("close", failed);
      controller.signal.addEventListener("abort", aborted, { once: true });
      if (controller.signal.aborted) { aborted(); return; }
      try {
        control.accept();
        control.send(JSON.stringify({ type: "session.close", event_id: `close_${crypto.randomUUID()}` }));
      } catch { failed(); }
    });
  } catch (error) {
    if (request.signal.aborted) throw new AssistantUpstreamError("request_aborted", "请求已取消。", 499, false);
    if (error instanceof AssistantUpstreamError) throw error;
    if (controller.signal.aborted) throw new AssistantUpstreamError("voice_close_unconfirmed", "会话结束状态尚未确认，请重试结束会话。", 504, true);
    throw new AssistantUpstreamError("voice_close_unconfirmed", "暂时无法确认会话结束，请重试。", 502, true);
  } finally {
    clearTimeout(timer); request.signal.removeEventListener("abort", cancel);
    try { socket?.close(1000, "control-complete"); } catch { /* Socket may have finalized already. */ }
  }
}
