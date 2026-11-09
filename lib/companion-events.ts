/** Lightweight bridge: opening the assistant never loads its UI into reading's initial chunk. */
export type ArticleSelectionSource = {
  id: string; title: string; author?: string;
  paragraphs: { id?: string; text: string; sentences?: string[] }[];
};
export type CompanionQuote = {
  id: string; articleId: string; title: string; author: string;
  start: { paragraph: number; offset: number }; end: { paragraph: number; offset: number };
  text: string; before?: string; after?: string; carried?: boolean;
};
export type CompanionSelectionRequest = {
  id: string; article: ArticleSelectionSource; quote: CompanionQuote;
  action: "ask" | "translate" | "define" | "grammar";
};
export function requestCompanionSelection(input: Omit<CompanionSelectionRequest, "id">) {
  const request = { ...input, id: crypto.randomUUID() };
  window.dispatchEvent(new CustomEvent<CompanionSelectionRequest>("vocab-companion-selection", { detail: request }));
}
export function setCompanionArticle(article: ArticleSelectionSource | null) {
  window.dispatchEvent(new CustomEvent<ArticleSelectionSource | null>("vocab-companion-article", { detail: article }));
}
