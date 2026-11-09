import type { ArticleSelectionSource } from "@/lib/companion-events";
export type Article = ArticleSelectionSource;
export type Paragraph = Article["paragraphs"][number];
export function sentenceSpans(paragraph: Paragraph) {
  const spans: { index: number; start: number; end: number; text: string }[] = [];
  const expression = /[^.!?。！？]+(?:[.!?。！？]+|$)/gu;
  for (const match of paragraph.text.matchAll(expression)) {
    const text = match[0];
    spans.push({ index: spans.length, start: match.index!, end: match.index! + text.length, text });
  }
  return spans;
}
export const WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"];
export function dayLabel(at: number) { return new Date(at).toLocaleDateString("zh-CN", { month: "short", day: "numeric" }); }
