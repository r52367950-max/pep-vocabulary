import { env } from 'cloudflare:workers';
import { authenticatedUserKey } from '../server-user';
import { consumeRateLimit, privateJson } from '../http';
import { AssistantInputError } from '../assistant/core';
import { assistantErrorResponse, assertSameOrigin, readJsonRequest } from '../assistant/server';
import { journalDays, journalMetadata } from '../learning-journal/store';
import { contextMetadata, resolveLearningContext } from '../learning-memory/context';
import type { LexiconIndexEntry } from '../lexicon';
import { decodeLexiconIndex } from '../lexicon-index-codec.mjs';
import { retrieveReadingDictationCandidates } from './reading-candidates';
import { parsePlanInput, retrieveDictationCandidates } from './dictation-planner';

export const VOICE_REASONING_MODEL = 'gpt-6.1-terra';

export const PREPARE_DICTATION_TOOL = {
  type: 'function', name: 'prepare_dictation', strict: true,
  description: 'Find a short dictation in the real released vocabulary or official reading library using the learner’s latest words, textbook book/unit, topic or article title. Use when the learner mentions material to practise or asks for a suitable dictation. Article titles select exact sentences from validated source text. This prepares an app exercise; it does not play, grade or start it. Never guess a textbook source or read target answers aloud.',
  parameters: { type: 'object', additionalProperties: false, properties: {
    query: { type: 'string', description: 'Latest requested material or topic, including exact words/book/unit. For a generic recommendation based on learning history use 按学习记录推荐.' },
    count: { type: ['integer', 'null'], minimum: 3, maximum: 12, description: 'Short exercise size, or null for 8.' },
    mode: { type: ['string', 'null'], enum: ['words', 'sentences', null], description: 'words for words/phrases; sentences when the learner references a reading article/title; words for vocabulary words/phrases.' },
  }, required: ['query', 'count', 'mode'] },
};
export const LIVE_LEARNING_POLICY = `
Delegation policy:
Backend tools:
- prepare_dictation: retrieve real vocabulary by exact word, textbook/unit or topic and prepare a short exercise in the app.
Generate <|SpawnThinking|> when:
- The learner asks to practise dictation, says which words/book/unit to work on, or asks for a dictation fitting this learning conversation.
- A correction changes the requested learning material.
- A question needs careful reasoning rather than a simple conversational response.
Do not generate <|SpawnThinking|> when:
- Greeting, asking one clarification, or repeating a verified result.
Generate <|SpawnThinking|> before answering a request that depends on backend work. Do not claim you have searched or prepared an exercise until the tool confirms it. Never guess missing results. The app controls fixed playback and grading; do not read exercise targets in the live conversation.`;

export function parseLiveDictationArguments(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AssistantInputError('invalid_request', '听写检索参数无效。');
  const args = value as Record<string, unknown>;
  if (Object.keys(args).some(key => !['query', 'count', 'mode'].includes(key)) || typeof args.query !== 'string' || !args.query.trim() || args.query.length > 600 || /[\u0000-\u001f\u007f]/.test(args.query)) throw new AssistantInputError('invalid_request', '请提供简短的词语、教材单元或主题。');
  const count = args.count ?? 8, mode = args.mode ?? 'words';
  if (!Number.isSafeInteger(count) || (count as number) < 3 || (count as number) > 12 || !['words', 'sentences'].includes(mode as string)) throw new AssistantInputError('invalid_request', '听写数量或内容类型无效。');
  return { query: args.query.trim(), count: count as number, mode: mode as 'words' | 'sentences' };
}

/** This read-only tool uses the backend's query, never a browser-selected account or invented answer. */
export async function prepareLiveDictation(request: Request): Promise<Response> {
  try {
    assertSameOrigin(request);
    const user = await authenticatedUserKey();
    if (!user) throw new AssistantInputError('authentication_required', '请先登录。', 401);
    const body = await readJsonRequest(request) as Record<string, unknown>;
    if (body.name !== 'prepare_dictation' || typeof body.callId !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(body.callId) || typeof body.sessionId !== 'string' || !/^[A-Za-z0-9_-]{4,200}$/.test(body.sessionId)) throw new AssistantInputError('invalid_request', '学习工具请求无效。');
    const args = parseLiveDictationArguments(body.arguments);
    const context = await resolveLearningContext(user, body);
    if (typeof body.accountScope !== 'string' || body.accountScope !== context.accountScope) throw new AssistantInputError('learning_account_changed', '账户已改变，请重新开始。', 409);
    if (!env.DB) throw new AssistantInputError('unavailable', '学习工具暂不可用。', 503);
    const lease = await env.DB.prepare('SELECT request_count FROM ai_rate_limits WHERE bucket_key = ?').bind(`voice-session:${user}:${body.sessionId}`).first<{ request_count: number }>();
    if (!lease || lease.request_count <= Date.now()) throw new AssistantInputError('voice_session_missing', '语音会话已结束，请重新开始。', 409);
    const now = Date.now(), minute = Math.floor(now / 60_000);
    if (await consumeRateLimit(env.DB, `voice-learning-tool:${user}:${minute}`, (minute + 1) * 60_000, 20) !== null) throw new AssistantInputError('rate_limited', '学习检索过于频繁，请稍后再试。', 429);
    const assets = (env as unknown as { ASSETS?: { fetch: typeof fetch } }).ASSETS;
    if (!assets) throw new AssistantInputError('unavailable', '正式词库暂不可用。', 503);
    const response = await assets.fetch(new Request(new URL('/data/v1/index.json', request.url)));
    if (!response.ok) throw new AssistantInputError('unavailable', '正式词库暂不可用。', 503);
    let rows: LexiconIndexEntry[];
    try { rows = decodeLexiconIndex(await response.json()) as LexiconIndexEntry[]; }
    catch { throw new AssistantInputError('unavailable', '正式词库格式无效。', 503); }
    const journal = context.enabled && (await journalMetadata(user)).enabled ? await journalDays(user, 7) : [];
    const recentRefs = journal.flatMap(day => day.events.slice(0, 8).flatMap(event => event.refIds)).slice(0, 80);
    const reading = await retrieveReadingDictationCandidates(assets, request, { query: args.query, recentRefs });
    const vocabulary = retrieveDictationCandidates(rows, parsePlanInput({ text: args.query }), {
      recentRefs,
      recentSummaries: journal.map(day => day.summary.slice(0, 1200)), allowDefault: true,
    });
    const candidates = reading.articleRequested ? reading.items : vocabulary.filter(item => item.mode === args.mode);
    const items = candidates.slice(0, args.count);
    // Content may have changed while reading the asset; do not attach stale account context.
    await resolveLearningContext(user, body);
    if (request.signal.aborted) throw new AssistantInputError('request_aborted', '已取消学习检索。', 499);
    return privateJson({ ...contextMetadata(context), items,
      reason: items.length ? `已按你刚才提到的材料，从${reading.articleRequested ? '正式阅读文章' : '正式词库'}准备 ${items.length} 项听写。` : '',
      clarification: items.length ? '' : reading.articleRequested ? reading.clarification : args.mode === 'sentences' ? '这份词库没有对应的完整句子。请在听写中选择文章片段，或改练词与短语。' : '没有找到对应材料。请再说一下具体词语、教材册次或单元。',
    });
  } catch (error) { return assistantErrorResponse(error); }
}
