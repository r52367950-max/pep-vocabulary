import type { LexiconIndexEntry } from "./lexicon";

export const READING_CATEGORIES = { essay: "散文与随笔", fiction: "故事与小说", science: "科学与世界" } as const;
export type ReadingCategory = keyof typeof READING_CATEGORIES;
export type Difficulty = "A2" | "B1" | "B2" | "C1";
export type ReadingMeta = {
  id: string; title: string; titleZh?: string; author: string; sourceUrl: string;
  rights: { label: string; basis: string; url: string };
  category: ReadingCategory; wordCount: number; difficulty: Difficulty; difficultyNote: string;
  form: "original" | "excerpt" | "adapted" | "original-writing" | "imported";
  background: string; backgroundEn?: string; publicationYear?: number; addedIn: string;
};
export type LibraryArticle = ReadingMeta & {
  paragraphs: { en: string; zh?: string }[]; targets?: string[];
  questions?: { id: string; prompt: string; options: string[]; answerIndex: number; explanation: string }[];
};
export const READING_FORMS = { original: "原文", excerpt: "原文节选", adapted: "改写", "original-writing": "词迹原创", imported: "个人导入" } as const;
export const LENGTHS = ["全部篇幅", "250 词以内", "250–499 词", "500–899 词", "900 词以上"] as const;
export function lengthBand(count: number) { return count < 250 ? 1 : count < 500 ? 2 : count < 900 ? 3 : 4; }
export function countReadingWords(text: string) { return text.match(/[A-Za-z]+(?:['’][A-Za-z]+)*/g)?.length ?? 0; }
const validId = (id: unknown): id is string => typeof id === "string" && /^[a-z0-9][a-z0-9-]{0,90}$/.test(id);
export function safeSourceUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 2048) return false;
  try { const url = new URL(value); return url.protocol === "https:" && !url.username && !url.password; } catch { return false; }
}
const text = (value: unknown, max = 2000): value is string => typeof value === "string" && value.trim().length > 0 && value.length <= max;
export function validReadingMeta(value: unknown): value is ReadingMeta {
  if (!value || typeof value !== "object") return false;
  const a = value as ReadingMeta;
  return validId(a.id) && text(a.title, 250) && text(a.author, 250) && (safeSourceUrl(a.sourceUrl) || a.form === "imported" && a.sourceUrl === "")
    && !!a.rights && text(a.rights.label, 250) && text(a.rights.basis, 4000) && (safeSourceUrl(a.rights.url) || a.form === "imported" && a.rights.url === "")
    && Object.hasOwn(READING_CATEGORIES, a.category) && ["A2", "B1", "B2", "C1"].includes(a.difficulty)
    && text(a.difficultyNote) && text(a.background, 4000) && Object.hasOwn(READING_FORMS, a.form)
    && Number.isInteger(a.wordCount) && a.wordCount >= 40 && a.wordCount <= 6000
    && text(a.addedIn, 20) && (a.titleZh === undefined || typeof a.titleZh === "string" && a.titleZh.length <= 250)
    && (a.backgroundEn === undefined || text(a.backgroundEn, 4000))
    && (a.publicationYear === undefined || Number.isInteger(a.publicationYear) && a.publicationYear > 0 && a.publicationYear <= 2100);
}
export function validLibraryArticle(value: unknown, id: string): value is LibraryArticle {
  if (!validReadingMeta(value) || value.id !== id) return false;
  const a = value as LibraryArticle;
  if (!Array.isArray(a.paragraphs) || !a.paragraphs.length || a.paragraphs.length > 300) return false;
  if (!a.paragraphs.every(p => p && text(p.en, 16000) && (p.zh === undefined || text(p.zh, 16000)))) return false;
  if (countReadingWords(a.paragraphs.map(p => p.en).join(" ")) !== a.wordCount) return false;
  if (a.targets !== undefined && (!Array.isArray(a.targets) || a.targets.length > 100 || !a.targets.every(w => text(w, 100)))) return false;
  return a.questions === undefined || Array.isArray(a.questions) && a.questions.length <= 10 && a.questions.every(q => q && validId(q.id) && text(q.prompt) && text(q.explanation) && Array.isArray(q.options) && q.options.length >= 2 && q.options.length <= 6 && q.options.every(o => text(o, 1000)) && Number.isInteger(q.answerIndex) && q.answerIndex >= 0 && q.answerIndex < q.options.length);
}

async function readJson(path: string, signal: AbortSignal, maxBytes: number): Promise<unknown> {
  const response = await fetch(path, { signal, credentials: "same-origin" });
  if (!response.ok || response.redirected || !response.headers.get("content-type")?.includes("application/json")) throw new Error("内容暂时无法载入，请稍后重试。");
  if (Number(response.headers.get("content-length")) > maxBytes) throw new Error("内容大小异常。");
  const reader = response.body?.getReader();
  if (!reader) throw new Error("内容为空。");
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > maxBytes) throw new Error("内容大小异常。"); chunks.push(value); }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}
let catalog: ReadingMeta[] | undefined;
const articles = new Map<string, LibraryArticle>();
export async function loadReadingCatalog(signal: AbortSignal): Promise<ReadingMeta[]> {
  if (catalog) return catalog;
  const value = await readJson("/readings/v1/index.json", signal, 500_000);
  if (!Array.isArray(value) || !value.length || value.length > 500 || !value.every(validReadingMeta) || new Set(value.map(a => a.id)).size !== value.length) throw new Error("阅读目录校验失败，请刷新后重试。");
  catalog = value; return value;
}
export async function loadLibraryArticle(id: string, signal: AbortSignal): Promise<LibraryArticle> {
  if (!validId(id)) throw new Error("文章地址无效。");
  if (articles.has(id)) return articles.get(id)!;
  const value = await readJson(`/readings/v1/articles/${id}.json`, signal, 160_000);
  if (!validLibraryArticle(value, id)) throw new Error("文章内容校验失败，请重试。");
  if (articles.size >= 8) articles.delete(articles.keys().next().value!);
  articles.set(id, value); return value;
}
const common = new Set("about after again also another been before being between both came come could each even every first from have into just like made make many more most much must only other over said same shall should some such than that their them then there these they this those through under very want were what when where which while will with would your little upon once went down know back well long never away good great himself herself nothing something anything without still might until though because however always soon around".split(" "));
export function matchReadingWords(paragraphs: readonly { en: string }[], index: readonly LexiconIndexEntry[], preferred?: readonly string[]): LexiconIndexEntry[] {
  const wanted = new Set(preferred?.map(w => w.toLowerCase()) ?? paragraphs.flatMap(p => p.en.toLowerCase().match(/[a-z]+(?:['’][a-z]+)*/g) ?? []).filter(w => w.length > 3 && !common.has(w)));
  const found = new Map<string, LexiconIndexEntry>();
  for (const entry of index) { const word = entry.headword.toLowerCase(); if (wanted.has(word) && !found.has(word)) found.set(word, entry); }
  return [...wanted].flatMap(w => found.has(w) ? [found.get(w)!] : []).slice(0, 60);
}
