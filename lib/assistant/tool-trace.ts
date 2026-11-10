/** The UI only retains fixed, factual execution metadata from the server. */
const TOOL_LABELS = {
  lookup_words: ["已查词库", "查词未完成"],
  search_lexicon: ["已查词库", "词库搜索未完成"],
  calculate: ["已计算", "计算未完成"],
  text_stats: ["已统计文本", "文本统计未完成"],
  read_source: ["已读取资料", "资料读取未完成"],
} as const;

export type ChatToolName = keyof typeof TOOL_LABELS;
export type ChatToolStep = { name: ChatToolName; ok: boolean; cached: boolean };

/** Use at both network and local-history boundaries; never retain arguments or source text. */
export function parseChatToolSteps(value: unknown): ChatToolStep[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 6).flatMap((item): ChatToolStep[] => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const row = item as Record<string, unknown>;
    if (typeof row.name !== "string" || !Object.hasOwn(TOOL_LABELS, row.name)
      || typeof row.ok !== "boolean" || typeof row.cached !== "boolean") return [];
    return [{ name: row.name as ChatToolName, ok: row.ok, cached: row.cached }];
  });
}

export function chatToolSummary(steps: readonly ChatToolStep[]): string {
  return [...new Set(steps.map(step => TOOL_LABELS[step.name][step.ok ? 0 : 1]))].join(" · ");
}
