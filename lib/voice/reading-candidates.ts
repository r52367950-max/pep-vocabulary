import { AssistantInputError } from '../assistant/core';
import { countReadingWords, READING_FORMS, validLibraryArticle, validReadingMeta, type LibraryArticle, type ReadingMeta } from '../reading-library';
import type { DictationItem } from './dictation';

type AssetReader = { fetch: (request: Request) => Promise<Response> };
export type ReadingDictationCandidates = { items: DictationItem[]; articleRequested: boolean; titles: string[]; clarification: string };
const empty = (articleRequested = false, clarification = ''): ReadingDictationCandidates => ({ items: [], articleRequested, titles: [], clarification });
const unavailable = (): never => { throw new AssistantInputError('reading_unavailable', '阅读材料暂时无法核验，请稍后重试。', 503); };
const normal = (value: string) => value.normalize('NFKC').toLowerCase().replace(/[\p{P}\p{S}]+/gu, ' ').replace(/\s+/g, ' ').trim();
const generic = (query: string) => !query || /^(?:开始|开始听写|听写|听写练习|推荐听写|给我推荐听写|帮我安排听写|自动推荐|按学习记录推荐|start|dictation)[。！!\s]*$/i.test(query.trim());
const readingRequest = (query: string) => /文章|阅读|短文|课文|\b(?:article|reading|passage|essay)\b/i.test(query);
const recentReadingRequest = (query: string) => {
  if (/《[^》]+》|「[^」]+」|“[^”]+”|"[^"]+"/.test(query)) return false;
  return /^(?:用|把|帮我|听写|从)?(?:最近|上次|刚才|这篇|那篇|刚读)(?:读过的|阅读的|那篇|这篇|的)*(?:文章|阅读|短文)(?:来一组听写|听写|练习|来一组|做听写)?[。！!\s]*$/i.test(query.trim())
    || /^(?:(?:from|use|dictate|practice|practise|the|please)\s+)*(?:this|that|last|recent)\s+(?:article|reading|story)(?:\s+(?:for dictation|please))?[.!?\s]*$/i.test(query.trim());
};
async function readAssetJson(assets: AssetReader, request: Request, path: string, maxBytes: number): Promise<unknown> {
  if (request.signal.aborted) throw new AssistantInputError('request_aborted', '检索已取消。', 499);
  const response = await assets.fetch(new Request(new URL(path, request.url), { signal: request.signal }));
  if (!response.ok || response.redirected || !response.headers.get('content-type')?.includes('application/json')) return unavailable();
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > maxBytes) return unavailable();
  const reader = response.body?.getReader(); if (!reader) return unavailable();
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      if (request.signal.aborted) throw new AssistantInputError('request_aborted', '检索已取消。', 499);
      const { done, value } = await reader.read(); if (done) break;
      size += value.length; if (size > maxBytes) return unavailable(); chunks.push(value);
    }
  } catch (error) { await reader.cancel().catch(() => undefined); throw error; }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { return unavailable(); }
}
function titleMatches(query: string, row: ReadingMeta) {
  const normalized = normal(query), title = normal(row.title), chinese = normal(row.titleZh ?? '');
  if (!normalized) return false;
  // Full title/ID matches prevent a general topic such as "walking" selecting a different work.
  if (normalized.includes(normal(row.id)) || title.length >= 4 && ` ${normalized} `.includes(` ${title} `)) return true;
  return chinese.length >= 2 && normalized.includes(chinese);
}
function referenceId(ref: string) {
  if (/^[a-z0-9][a-z0-9-]{0,90}$/.test(ref)) return ref;
  return /^(?:reading|article):([a-z0-9][a-z0-9-]{0,90})(?::|$)/.exec(ref)?.[1] ?? '';
}
export function articleDictationSentences(article: LibraryArticle): DictationItem[] {
  const output: DictationItem[] = [], seen = new Set<string>();
  const segmenter = typeof Intl.Segmenter === 'function' ? new Intl.Segmenter('en', { granularity: 'sentence' }) : null;
  const source = `${article.title} · ${article.author} · ${READING_FORMS[article.form]} · ${article.rights.label} · ${article.sourceUrl}`;
  const conciseSource = source.length <= 500 ? source : `${article.title} · ${article.author} · ${article.rights.label} · ${article.id}`.slice(0, 500);
  for (const [paragraph, value] of article.paragraphs.entries()) {
    const sentences = segmenter ? [...segmenter.segment(value.en)].map(part => part.segment) : value.en.match(/[^.!?]+[.!?]+(?:["”’']+)?|[^.!?]+$/g) ?? [];
    for (const [sentence, raw] of sentences.entries()) {
      const text = raw.trim(), words = countReadingWords(text);
      if (text.length > 300 || words < 4 || words > 30 || !/[A-Za-z]/.test(text) || seen.has(text)) continue;
      // Every target is an unchanged substring of a validated published paragraph.
      if (!value.en.includes(text)) continue;
      seen.add(text); output.push({ id: `reading:${article.id}:p${paragraph + 1}:s${sentence + 1}`, mode: 'sentences', text, hint: '', source: conciseSource });
      if (output.length >= 12) return output;
    }
  }
  return output;
}

/** Only same-Site official assets are read. Personal imported articles are never assumed to be on the server. */
export async function retrieveReadingDictationCandidates(assets: AssetReader, request: Request, options: { query: string; recentRefs?: string[] }): Promise<ReadingDictationCandidates> {
  const query = typeof options.query === 'string' ? options.query.slice(0, 5000).trim() : '';
  const refs = (options.recentRefs ?? []).filter(ref => typeof ref === 'string').slice(0, 80).map(referenceId).filter(Boolean);
  if (!query && !refs.length) return empty();
  const catalog = await readAssetJson(assets, request, '/readings/v1/index.json', 500_000);
  if (!Array.isArray(catalog) || !catalog.length || catalog.length > 500 || !catalog.every(validReadingMeta) || new Set(catalog.map(row => row.id)).size !== catalog.length) return unavailable();
  let selected = catalog.filter(row => titleMatches(query, row));
  const canUseRecent = generic(query) || recentReadingRequest(query);
  if (!selected.length && canUseRecent) {
    const byId = new Map(catalog.map(row => [row.id, row]));
    selected = [...new Set(refs)].flatMap(id => byId.has(id) ? [byId.get(id)!] : []);
  }
  const articleRequested = selected.length > 0 || readingRequest(query);
  if (!selected.length) return empty(articleRequested, articleRequested ? '没有找到这篇正式阅读文章。请说出文章标题；个人导入文章需要在阅读页选中后提供片段。' : '');
  // Read at most two exact catalog entries. Never construct a path from an unvalidated query/ref.
  const picked = selected.slice(0, 2), items: DictationItem[] = [];
  for (const meta of picked) {
    const value = await readAssetJson(assets, request, `/readings/v1/articles/${meta.id}.json`, 160_000);
    if (!validLibraryArticle(value, meta.id) || value.form === 'imported' || value.title !== meta.title || value.sourceUrl !== meta.sourceUrl) return unavailable();
    items.push(...articleDictationSentences(value));
  }
  return { items, articleRequested: true, titles: picked.map(row => row.title), clarification: items.length ? '' : '这篇文章没有适合本轮长度的完整短句，请选择其他文章或练习词与短语。' };
}
