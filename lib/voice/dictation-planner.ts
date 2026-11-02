import { normalizeEntry, type LexiconIndexEntry } from '../lexicon';
import type { DictationItem } from './dictation';
import { AssistantInputError } from '../assistant/core';
const invalid = (message: string): never => { throw new AssistantInputError('invalid_request', message); };
export function boundedText(value: unknown, maximum: number, optional = false): string {
  if (optional && value === undefined) return '';
  if (typeof value !== 'string' || value.length > maximum || (!optional && !value.trim())) return invalid('文字格式或长度无效。');
  return value.trim();
}
export function operationId(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{16,100}$/.test(value)) return invalid('操作编号无效。');
  return value;
}
export type DictationPlanInput = {
  text: string; topic: string; path: string;
  messages: { role: 'user' | 'assistant'; text: string }[];
  articleCandidates: DictationItem[];
  allowTopicWords: boolean;
};
export function parsePlanInput(body: Record<string, unknown>): DictationPlanInput {
  if (body.allowTopicWords !== undefined && typeof body.allowTopicWords !== 'boolean') return invalid('主题选词设置无效。');
  const messages = body.messages ?? [];
  if (!Array.isArray(messages) || messages.length > 12) return invalid('最近对话最多 12 条。');
  const parsed = messages.map(row => {
    if (!row || !['user', 'assistant'].includes(row.role)) return invalid('对话格式无效。');
    return { role: row.role as 'user' | 'assistant', text: boundedText(row.text, 1200) };
  });
  const articles = body.articleCandidates ?? [];
  if (!Array.isArray(articles) || articles.length > 30) return invalid('文章候选过多。');
  const seen = new Set<string>();
  const articleCandidates = articles.map(row => {
    const id = boundedText(row?.id, 160);
    if (!id.startsWith('article:') || seen.has(id)) return invalid('文章候选编号无效。');
    seen.add(id);
    return { id, mode: 'sentences' as const, text: boundedText(row.text, 700), hint: '', source: `用户提供文章 · ${boundedText(row.source, 150)}` };
  });
  return { text: boundedText(body.text, 2000, true), topic: boundedText(body.topic, 500, true), path: boundedText(body.path, 500, true), messages: parsed, articleCandidates, allowTopicWords: body.allowTopicWords === true };
}
const numerals: Record<string, string> = { 一:'1',二:'2',三:'3',四:'4',五:'5',六:'6',七:'7',八:'8',九:'9',十:'10' };
function normalizedQuery(text: string) {
  return text.toLowerCase().replace(/第?([一二三四五六七八九十]|[0-9]+)单元/g, (_, n: string) => ` unit${numerals[n] ?? n} `)
    .replace(/unit\s*([0-9]+)/g, 'unit$1')
    .replace(/(选择性必修|必修)第?([一二三四五六七八九十]|[0-9]+)(?:册)?/g, (_, kind: string, n: string) => ` hs-${kind === '必修' ? 'r' : 's'}${numerals[n] ?? n} `)
    .replace(/第([一二三四五六七八九十]|[0-9]+)册/g, (_, n: string) => ` volume${numerals[n] ?? n} `);
}
function genericRequest(text: string) {
  return !text.trim() || /^(?:开始|开始听写|听写|听写练习|推荐听写|给我推荐听写|帮我安排听写|自动推荐|按学习记录推荐|start|dictation)[。！!\s]*$/i.test(text.trim());
}
function explicitRequest(input: DictationPlanInput) {
  const latest = input.messages.filter(m => m.role === 'user').at(-1)?.text ?? '';
  return !genericRequest(input.text) ? input.text : !genericRequest(latest) ? latest : '';
}
/** Theme expansion is opt-in; a specified textbook or supplied article stays source-bound. */
export function allowsTopicWords(input: DictationPlanInput) {
  const query = explicitRequest(input);
  return input.allowTopicWords && !!query && !input.articleCandidates.length
    && !/教材|课本|课标|单元|必修|人教版|[上下]册|第[一二三四五六七八九十0-9]+册|\b(?:hs-[rs][0-9]+|jh-?[0-9]+[ab]?|std-hs|pep|unit\s*[0-9]+|textbook|curriculum|book\s*[0-9]+|volume\s*[0-9]+)\b/i.test(query);
}
function textbookWord(row: LexiconIndexEntry): DictationItem {
  const entry = normalizeEntry(row);
  return { id: `word:${entry.id}`, wordId: entry.id, mode: 'words', text: entry.headword, hint: entry.chineseCore, source: entry.sources.map(s => `${s.volume} ${s.unit}`).join('；').slice(0, 500) };
}
const canonicalWord = (value: string) => value.normalize('NFKC').replace(/[’‘]/g, "'").replace(/\s+/g, ' ').trim().toLowerCase();
export type DictationRetrievalContext = { recentRefs?: string[]; recentSummaries?: string[]; allowDefault?: boolean };
/** Trusted history is supplied separately by the server, never taken from body.path. */
export function retrieveDictationCandidates(rows: LexiconIndexEntry[], input: DictationPlanInput, context: DictationRetrievalContext = {}): DictationItem[] {
  const explicit = explicitRequest(input);
  const query = normalizedQuery(explicit || [input.topic, ...(context.recentRefs ?? []), ...(context.recentSummaries ?? [])].join(' '));
  const terms = [...new Set(query.match(/[a-z0-9]+(?:[-'][a-z0-9]+)*|[\u4e00-\u9fff]{2,}/g) ?? [])];
  const books = explicit ? query.match(/hs-[rs][0-9]+/g) ?? [] : [];
  const units = explicit ? query.match(/unit[0-9]+/g) ?? [] : [];
  const volumes = explicit ? query.match(/volume[0-9]+/g) ?? [] : [];
  const eligible = rows.filter(row => row.flags?.formalReleaseEligible && typeof row.headword === 'string');
  const ranked = eligible.map((row, order) => {
    const sourceFields = row.sources.map(s => normalizedQuery(`${s.bookId} ${s.volume} ${s.unit} volume${/([0-9]+)$/.exec(s.bookId)?.[1] ?? ''}`));
    const fields = [row.id, row.headword, row.chineseCore, ...sourceFields].map(normalizedQuery).filter(Boolean);
    const matchesSource = sourceFields.some(source => [...books, ...units, ...volumes].every(term => source.split(/\s+/).includes(term)));
    const score = (books.length || units.length || volumes.length) && !matchesSource ? 0 : terms.reduce((n, term) => n + fields.reduce((v, field) => v + (field === term ? 6 : field.includes(term) || term.includes(field) ? 1 : 0), 0), 0);
    return { row, score, order };
  }).sort((a, b) => b.score - a.score || a.order - b.order);
  let selected = ranked.filter(r => r.score > 0).slice(0, 120).map(r => r.row);
  // No fallback for an explicit unmatched request or an unrecognised caller-supplied topic.
  const defaultTopic = /^(?:everyday|city|culture|school|environment|technology)?$/.test(input.topic);
  if (!selected.length && !explicit && context.allowDefault && defaultTopic && !input.articleCandidates.length) {
    const count = Math.min(120, eligible.length);
    selected = Array.from({ length: count }, (_, i) => eligible[Math.floor(i * eligible.length / count)]);
  }
  return [...input.articleCandidates, ...selected.map(textbookWord)];
}
export function parseDictationPlan(content: string, candidates: DictationItem[], options: { allowTopicWords?: boolean; rows?: LexiconIndexEntry[] } = {}) {
  const raw = JSON.parse(content);
  if (!raw || !Array.isArray(raw.itemIds) || raw.itemIds.length > 20) return invalid('推荐题单格式无效。');
  const byId = new Map(candidates.map(item => [item.id, item]));
  const ids = raw.itemIds as unknown[];
  if (new Set(ids).size !== ids.length || ids.some(id => typeof id !== 'string' || !byId.has(id))) return invalid('推荐包含未经检索的题目。');
  const words = raw.words ?? [];
  if (!Array.isArray(words) || words.length + ids.length > 20 || (words.length && !options.allowTopicWords)) return invalid('推荐词汇格式无效。');
  const items = ids.map(id => byId.get(id as string)!);
  const seen = new Set(items.map(item => canonicalWord(item.text)));
  const known = new Map<string, LexiconIndexEntry>();
  for (const row of options.rows ?? []) if (row.flags?.formalReleaseEligible && typeof row.headword === 'string' && !known.has(canonicalWord(row.headword))) known.set(canonicalWord(row.headword), row);
  for (const word of words) {
    const text = boundedText(word?.word, 80).normalize('NFKC').replace(/[’‘]/g, "'").replace(/\s+/g, ' ');
    const hint = boundedText(word?.meaning, 140);
    if (!/^[A-Za-z]+(?:['-][A-Za-z]+)*(?: [A-Za-z]+(?:['-][A-Za-z]+)*){0,5}$/.test(text)) return invalid('主题选词只支持英文单词或短语。');
    const key = canonicalWord(text);
    if (seen.has(key)) continue;
    seen.add(key);
    const row = known.get(key);
    // IDs, textbook meanings and sources come exclusively from our published lexicon.
    items.push(row ? textbookWord(row) : { id: `ai-word:${key.replace(/ /g, '_')}`, mode: 'words', text, hint, source: 'AI 主题选词' });
  }
  const clarification = boundedText(raw.clarification, 400, true);
  if (!items.length && !clarification) return invalid('推荐题单为空。');
  return { items, reason: boundedText(raw.reason, 500, true), clarification };
}
export type RecognizedDictationRow = { label: string; text: string; uncertain: boolean };
export function parseRecognizedRows(content: string): { rows: RecognizedDictationRow[]; requiresConfirmation: true } {
  const raw = JSON.parse(content);
  if (!raw || !Array.isArray(raw.rows) || raw.rows.length > 30) return invalid('识别结果格式无效。');
  const rows = raw.rows.map((row: Record<string, unknown>) => {
    if (!row || typeof row.uncertain !== 'boolean') return invalid('识别结果缺少不确定性标记。');
    return { label: boundedText(row.label, 40, true), text: boundedText(row.text, 1000, true), uncertain: row.uncertain };
  });
  return { rows, requiresConfirmation: true };
}
/** MIME signature and pixel bounds are checked before any paid request. */
export function parseDictationImage(value: unknown) {
  if (typeof value !== 'string' || value.length > 2_800_000) return invalid('图片请压缩到 2MB 以内。');
  const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match || match[2].length % 4 !== 0) return invalid('只支持 JPEG、PNG 或 WEBP 图片。');
  const bytes = Uint8Array.from(atob(match[2]), c => c.charCodeAt(0));
  if (bytes.length < 24 || bytes.length > 2 * 1024 * 1024) return invalid('图片大小无效。');
  const view = new DataView(bytes.buffer); let width = 0, height = 0;
  if (match[1] === 'png' && view.getUint32(0) === 0x89504e47 && view.getUint32(4) === 0x0d0a1a0a && view.getUint32(12) === 0x49484452) { width = view.getUint32(16); height = view.getUint32(20); }
  if (match[1] === 'jpeg' && bytes[0] === 255 && bytes[1] === 216) {
    for (let i = 2; i + 8 < bytes.length;) {
      if (bytes[i++] !== 255) break;
      while (bytes[i] === 255) i++;
      const marker = bytes[i++]; if (marker === 217 || marker === 218) break;
      if (marker === 1 || marker >= 208 && marker <= 215) continue;
      if (i + 2 > bytes.length) break; const size = view.getUint16(i);
      if (size < 2 || i + size > bytes.length) break;
      if ([192,193,194].includes(marker) && size >= 8) { height = view.getUint16(i + 3); width = view.getUint16(i + 5); break; } i += size;
    }
  }
  if (match[1] === 'webp' && bytes.length >= 30 && view.getUint32(0) === 0x52494646 && view.getUint32(8) === 0x57454250) {
    const tag = view.getUint32(12);
    if (tag === 0x56503858 && !(bytes[20] & 2)) { width = 1 + bytes[24] + (bytes[25] << 8) + (bytes[26] << 16); height = 1 + bytes[27] + (bytes[28] << 8) + (bytes[29] << 16); }
    if (tag === 0x56503820 && bytes[23] === 157 && bytes[24] === 1 && bytes[25] === 42) { width = view.getUint16(26, true) & 16383; height = view.getUint16(28, true) & 16383; }
    if (tag === 0x5650384c && bytes[20] === 47) { width = 1 + bytes[21] + ((bytes[22] & 63) << 8); height = 1 + (bytes[22] >> 6) + (bytes[23] << 2) + ((bytes[24] & 15) << 10); }
  }
  if (!width || !height || width > 2400 || height > 2400 || width * height > 4_000_000) return invalid('请使用清晰的静态图片，最长边不超过 2400 像素，总像素不超过 400 万。');
  return { dataUrl: value, width, height };
}
