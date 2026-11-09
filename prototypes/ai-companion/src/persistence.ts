import type { Block, Conversation } from "./types";

/** Persisted form: normal conversations only, attachment previews dropped, unfinished answers marked stopped. */
export function serializeConversations(conversations: Conversation[]) {
  return JSON.stringify({
    version: 1,
    conversations: conversations.filter((conversation) => !conversation.temporary && conversation.messages.length).map((conversation) => ({
      ...conversation,
      messages: conversation.messages.map((message) => {
        if (message.role === "user") return { ...message, attachments: message.attachments.map((attachment) => ({ ...attachment, previewUrl: undefined })) };
        if (message.role === "assistant" && message.status === "streaming") return { ...message, status: "stopped" as const, blocks: truncateBlocks(message.blocks, message.revealed) };
        if (message.role === "assistant" && message.remainder) return { ...message, remainder: undefined };
        return message;
      }),
    })),
  });
}

export function parseStoredConversations(raw: string | null): Conversation[] | null {
  if (!raw || raw.length > 4_000_000) return null;
  try {
    const value = JSON.parse(raw) as { version?: unknown; conversations?: unknown };
    if (value.version !== 1 || !Array.isArray(value.conversations)) return null;
    return value.conversations.filter((item): item is Conversation => Boolean(item) && typeof item.id === "string" && typeof item.title === "string"
      && Array.isArray(item.messages) && item.temporary === false).slice(0, 100);
  } catch {
    return null;
  }
}

export function remainderBlocks(blocks: Block[], revealed: number): Block[] {
  const [lead, ...rest] = blocks;
  if (lead?.type !== "text") return blocks;
  const tail = lead.text.slice(revealed);
  return [...(tail ? [{ type: "text" as const, text: tail }] : []), ...rest];
}

export function truncateBlocks(blocks: Block[], revealed: number): Block[] {
  const lead = blocks[0];
  return lead?.type === "text" ? [{ type: "text", text: lead.text.slice(0, revealed) }] : [];
}
