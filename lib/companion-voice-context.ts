type VoiceContextMessage =
  | { role: "user"; text: string; quotes?: { text: string }[] }
  | { role: "assistant"; blocks: ({ type: "text"; text: string } | { type: string })[] }
  | { role: "voice"; captions: { speaker: string; text: string }[] }
  | { role: "result" };

function excerpt(text: string, limit: number, tail = false) {
  let part = tail ? text.slice(-limit) : text.slice(0, limit);
  if (/^[\uDC00-\uDFFF]/.test(part)) part = part.slice(1);
  if (/[\uD800-\uDBFF]$/.test(part)) part = part.slice(0, -1);
  return part;
}

/** The realtime API accepts a short opening prompt; retain recent turns and their explicit quote. */
export function companionVoiceContext(messages: readonly VoiceContextMessage[]): string {
  const lines = messages.slice(-6).flatMap((message) => {
    if (message.role === "user") return [
      ...(message.quotes ?? []).slice(-1).map((quote) => `引用：${excerpt(quote.text, 180)}`),
      `用户：${excerpt(message.text, 220, true)}`,
    ];
    if (message.role === "assistant") return message.blocks.flatMap((block) => block.type === "text" && "text" in block ? [`助手：${excerpt(block.text, 180, true)}`] : []);
    if (message.role === "voice") return message.captions.slice(-3).map((caption) => `${caption.speaker === "user" ? "用户" : "助手"}：${excerpt(caption.text, 180, true)}`);
    return [];
  });
  return excerpt(lines.join("\n"), 600, true);
}
