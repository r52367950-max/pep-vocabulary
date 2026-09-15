import type { ReadingCategory } from "./reading-library";

/** Article IDs choose one of three shared covers, independently of shelf order. */
export function readingCoverBase(category: ReadingCategory, articleId: string): string {
  let hash = 2166136261;
  for (let i = 0; i < articleId.length; i++) {
    hash = Math.imul(hash ^ articleId.charCodeAt(i), 16777619);
  }
  const variant = (hash >>> 0) % 3 + 1;
  return `/images/reading-${category}${variant === 1 ? "" : `-${variant}`}`;
}
