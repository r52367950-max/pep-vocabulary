import type { Conversation, Draft } from "./types";

export type ConversationListRow = { conversation: Conversation; title: string; draftOnly: boolean; day: string; dateLabel: string };
const dayLabel = new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric" });

/** Per-view cache: typing in the active composer cannot change the saved conversation list. */
export function createConversationListSelector() {
  let previous: readonly Conversation[] | null = null;
  let previousActive = "";
  let draftInputs = new Map<string, Draft | undefined>();
  let rows: ConversationListRow[] = [];
  return (conversations: readonly Conversation[], drafts: Record<string, Draft>, activeId: string) => {
    if (previous === conversations && previousActive === activeId
      && [...draftInputs].every(([id, draft]) => drafts[id] === draft)) return rows;
    previous = conversations;
    previousActive = activeId;
    draftInputs = new Map();
    rows = conversations.flatMap((conversation): ConversationListRow[] => {
      if (conversation.temporary) return [];
      const draftOnly = conversation.messages.length === 0;
      const draft = drafts[conversation.id];
      if (draftOnly) {
        if (conversation.id === activeId) return [];
        draftInputs.set(conversation.id, draft);
        if (!draft || !(draft.text.trim() || draft.quotes.length || draft.attachments.length)) return [];
      }
      const date = new Date(conversation.updatedAt);
      const validDate = Number.isFinite(date.getTime());
      return [{ conversation, draftOnly, title: draftOnly ? draft?.text.slice(0, 24) || "未发送的草稿" : conversation.title,
        day: validDate ? date.toDateString() : "", dateLabel: validDate ? dayLabel.format(date) : "日期未知" }];
    }).sort((a, b) => b.conversation.updatedAt - a.conversation.updatedAt);
    return rows;
  };
}

export function conversationGroups(rows: ConversationListRow[], query: string, today: string): [string, ConversationListRow[]][] {
  const term = query.trim().toLowerCase();
  const groups: [string, ConversationListRow[]][] = [["今天", []], ["更早", []]];
  for (const row of rows) {
    if (term && !row.title.toLowerCase().includes(term) && !row.conversation.messages.some(message => message.role === "user" && message.text.toLowerCase().includes(term))) continue;
    groups[row.day === today ? 0 : 1][1].push(row);
  }
  return groups;
}
