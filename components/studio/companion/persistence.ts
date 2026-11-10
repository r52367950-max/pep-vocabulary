import { isModelChoice, type RequestPayload } from "./routing";
import type { Action, Block, Conversation, Message } from "./types";

export const COMPANION_HISTORY_PREFIX = "vocab-companion-history-v1:";
export const HISTORY_LIMITS = { conversations: 50, messages: 120, chars: 1_000_000 };
const text = (value: unknown, max: number) => typeof value === "string" ? value.slice(0, max) : "";
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const time = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;

function action(value: unknown): Action | null {
  const a = record(value), id = text(a.id, 120), label = text(a.label, 160);
  if (!id || !label) return null;
  if (a.intent === "open-reading") return { id, label, intent: a.intent };
  if (a.intent === "start-dictation" || a.intent === "start-review") return {
    id, label, intent: a.intent, title: text(a.title, 160),
    minutes: Math.max(5, Math.min(60, Number(a.minutes) || 15)),
    wordIds: Array.isArray(a.wordIds) ? a.wordIds.filter((id): id is string => typeof id === "string" && /^pep-[a-f0-9]{16}$/.test(id)).slice(0, 32) : [],
  };
  return null;
}
function blocks(value: unknown): Block[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 8).flatMap((item): Block[] => {
    const b = record(item);
    if (b.type === "text") return [{ type: "text", text: text(b.text, 24000) }];
    if (b.type === "notice") return [{ type: "notice", tone: b.tone === "warn" ? "warn" : "info", text: text(b.text, 1000) }];
    if (b.type === "actions" && Array.isArray(b.actions)) return [{ type: "actions", actions: b.actions.slice(0, 3).map(action).filter((a): a is Action => a !== null) }];
    return [];
  });
}
function request(value: unknown): RequestPayload {
  const r = record(value), reasoning = record(r.reasoning);
  return {
    model: text(r.model, 100), reasoning: { effort: reasoning.effort === null ? null : reasoning.effort === "low" || reasoning.effort === "high" ? reasoning.effort : "medium" },
    metadata: { task: "chat", routeSource: "auto" },
    context: { records: false, article: "none", quotes: 0, quoteChars: 0, readFiles: [], attachmentsOnly: [] },
  };
}
function message(value: unknown): Message | null {
  const m = record(value), id = text(m.id, 120), at = time(m.at);
  if (!id || !at) return null;
  if (m.role === "user") return { id, at, role: "user", text: text(m.text, 6000), quotes: [], attachments: [], via: "text" };
  if (m.role === "assistant") return {
    id, at, role: "assistant", status: m.status === "done" ? "done" : m.status === "error" ? "error" : "stopped",
    blocks: blocks(m.blocks), revealed: Number.MAX_SAFE_INTEGER, request: request(m.request), routeReason: "",
  };
  if (m.role === "result") {
    const r = record(m.result);
    if (!Array.isArray(r.rounds)) return null;
    return { id, at, role: "result", result: { title: text(r.title, 160), source: text(r.source, 160), mode: r.mode === "review" ? "review" : "dictation",
      rounds: r.rounds.slice(-6).map((round) => Array.isArray(round) ? round.slice(0, 100).flatMap((row) => {
        const a = record(row), item = record(a.item), score = record(a.score), wordId = text(item.id, 80);
        if (!/^pep-[a-f0-9]{16}$/.test(wordId)) return [];
        return [{ item: { id: wordId, text: text(item.text, 120), meaning: text(item.meaning, 300) }, answer: text(a.answer, 1000), score: { correct: score.correct === true, explanation: text(score.explanation, 1000) } }];
      }) : []),
    } };
  }
  if (m.role === "voice" && Array.isArray(m.captions)) return {
    id, at, role: "voice", seconds: Math.max(0, Math.min(7200, Number(m.seconds) || 0)),
    captions: m.captions.slice(-100).flatMap((caption) => {
      const c = record(caption);
      return c.speaker === "user" || c.speaker === "ai" ? [{ speaker: c.speaker as "user" | "ai", text: text(c.text, 6000) }] : [];
    }),
  };
  return null;
}

/** Explicit projections keep files, data URLs, drafts and temporary conversations out of storage. */
export function serializeConversations(conversations: readonly Conversation[]) {
  const prefix = '{"version":1,"conversations":[', suffix = "]}";
  const rows: string[] = [];
  let remaining = HISTORY_LIMITS.chars - prefix.length - suffix.length;
  for (const c of conversations) {
    if (c.temporary || !c.messages.length) continue;
    if (rows.length >= HISTORY_LIMITS.conversations) break;
    const metadata = JSON.stringify({ id: c.id, title: c.title.slice(0, 120), temporary: false, model: c.model, createdAt: c.createdAt, updatedAt: c.updatedAt });
    const header = metadata.slice(0, -1) + ',"messages":[', footer = "]}";
    const parts: string[] = [];
    let budget = remaining - header.length - footer.length - (rows.length ? 1 : 0);
    for (let index = c.messages.length - 1; index >= Math.max(0, c.messages.length - HISTORY_LIMITS.messages); index--) {
      const safe = message(c.messages[index]);
      if (!safe) continue;
      const encoded = JSON.stringify(safe), size = encoded.length + (parts.length ? 1 : 0);
      if (size > budget) break;
      parts.unshift(encoded); budget -= size;
    }
    if (!parts.length) break;
    const row = header + parts.join(",") + footer;
    remaining -= row.length + (rows.length ? 1 : 0); rows.push(row);
  }
  return prefix + rows.join(",") + suffix;
}

export function parseStoredConversations(raw: string | null): Conversation[] {
  if (!raw || raw.length > HISTORY_LIMITS.chars) return [];
  try {
    const data = record(JSON.parse(raw));
    if (data.version !== 1 || !Array.isArray(data.conversations)) return [];
    const seen = new Set<string>();
    return data.conversations.slice(0, HISTORY_LIMITS.conversations).flatMap((value): Conversation[] => {
      const c = record(value), id = text(c.id, 120);
      if (!id || seen.has(id) || c.temporary !== false || !Array.isArray(c.messages)) return [];
      seen.add(id);
      return [{ id, title: text(c.title, 120) || "对话", temporary: false, ...(isModelChoice(c.model) ? { model: c.model } : {}),
        createdAt: time(c.createdAt), updatedAt: time(c.updatedAt),
        messages: c.messages.slice(-HISTORY_LIMITS.messages).map(message).filter((m): m is Message => m !== null),
      }];
    });
  } catch { return []; }
}
