import type { ChatTurn } from "@/lib/assistant/chat-contract";
import type { Message } from "./types";

function textOf(message: Message): string {
  if (message.role === "user") return message.text || (message.quotes.length ? `请解释引用：${message.quotes.map((q) => q.text).join("\n")}` : "请阅读附件中的文字。");
  if (message.role === "assistant") return message.status === "done" ? message.blocks.filter((b) => b.type === "text").map((b) => b.text).join("\n") : "";
  if (message.role === "result") return `练习结果：${message.result.title}\n${message.result.rounds.map((round, index) => `第 ${index + 1} 轮：${round.map((r) => `${r.item.text}｜作答：${r.answer || "未作答"}｜${r.score.correct ? "正确" : "待复习"}`).join("；")}`).join("\n")}`;
  return "";
}
/** Text and voice share one bounded history; raw file bodies are supplied only by the current composer. */
export function requestHistory(messages: readonly Message[], latest: string): ChatTurn[] {
  const previous: ChatTurn[] = [];
  let remaining = 20000 - latest.length;
  outer: for (let index = messages.length - 1; index >= 0 && previous.length < 23; index--) {
    const message = messages[index];
    const turns: ChatTurn[] = message.role === "voice"
      ? message.captions.slice(-23).map((caption) => ({ role: caption.speaker === "ai" ? "assistant" : "user", text: caption.text.slice(0, 6000) }))
      : [{ role: message.role === "assistant" ? "assistant" : "user", text: textOf(message).slice(0, 6000) }];
    for (let turn = turns.length - 1; turn >= 0; turn--) {
      const entry = turns[turn];
      if (!entry.text) continue;
      if (entry.text.length > remaining || previous.length >= 23) break outer;
      previous.unshift(entry); remaining -= entry.text.length;
    }
  }
  return [...previous, { role: "user", text: latest }];
}
