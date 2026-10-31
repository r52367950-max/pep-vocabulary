import assert from 'node:assert/strict';
import test from 'node:test';
import { completionEndpoint, connectionEndpointCandidates, responsesPayload, fetchCompletion, usesOpenAIResponses, parseUsage } from '../lib/assistant/core.ts';

const result = { status: 'completed', output: [{ type: 'reasoning', summary: [] }, { type: 'message', content: [{ type: 'output_text', text: '{"ok":true}' }] }], usage: { input_tokens: 200, output_tokens: 40, input_tokens_details: { cached_tokens: 100 }, total_tokens: 240 } };
const sse = (events) => new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
const options = { idleMs: 1000, totalMs: 1000, stream: false };

test('only official OpenAI standard endpoints use Responses; compatible hosts retain chat protocol', () => {
  assert.equal(completionEndpoint('https://api.openai.com/v1'), 'https://api.openai.com/v1/responses');
  assert.deepEqual(connectionEndpointCandidates('openai-compatible', 'https://api.openai.com/v1'), ['https://api.openai.com/v1/responses']);
  assert.equal(usesOpenAIResponses('https://api.openai.com.attacker.test/v1'), false);
  assert.equal(usesOpenAIResponses('https://api.openai.com:8443/v1'), false);
  assert.equal(completionEndpoint('https://compatible.test/v1'), 'https://compatible.test/v1/chat/completions');
  assert.equal(completionEndpoint('https://api.deepseek.com/v1', 'deepseek'), 'https://api.deepseek.com/v1/chat/completions');
});

test('Responses payload retains instruction roles and JSON mode while removing chat-only fields', () => {
  const messages = [{ role: 'system', content: 'Return JSON.' }, { role: 'user', content: '{}' }];
  const payload = responsesPayload({ model: 'gpt-6.1-terra', messages, max_tokens: 123, temperature: .4, response_format: { type: 'json_object' }, stream: true, stream_options: { include_usage: true }, prompt_cache_key: 'key' }, 256);
  assert.deepEqual(payload, { model: 'gpt-6.1-terra', input: messages, max_output_tokens: 256, stream: true, store: false, text: { format: { type: 'json_object' } }, prompt_cache_key: 'key', reasoning: { effort: 'low' } });
});

test('Responses JSON and SSE use output content, cached usage and terminal status', async () => {
  const completion = await fetchCompletion(async () => Response.json(result), 'https://api.openai.com/v1/responses', {}, options);
  assert.equal(completion.content, '{"ok":true}');
  assert.deepEqual(completion.usage, { prompt: 200, completion: 40, cacheHit: 100, total: 240, estimated: false });
  const streamed = await fetchCompletion(async () => sse([{ type: 'response.output_text.delta', delta: '{"ok":' }, { type: 'response.completed', response: result }]), 'https://api.openai.com/v1/responses', {}, { ...options, stream: true });
  assert.deepEqual(streamed, completion);
  const truncated = await fetchCompletion(async () => sse([{ type: 'response.incomplete', response: { ...result, status: 'incomplete' } }]), 'https://api.openai.com/v1/responses', {}, { ...options, stream: true });
  assert.equal(truncated.finishReason, 'length');
  assert.equal(parseUsage(result.usage).cacheHit, 100);
});

test('Responses refusal, failed streams and incomplete transport fail safely', async () => {
  await assert.rejects(fetchCompletion(async () => Response.json({ ...result, output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'provider secret' }] }] }), 'https://api.openai.com/v1/responses', {}, options), (error) => error.code === 'model_refusal' && !error.message.includes('provider secret'));
  for (const events of [[{ type: 'response.failed', response: { error: { message: 'provider secret' } } }], [{ type: 'response.output_text.delta', delta: 'partial' }]]) {
    await assert.rejects(fetchCompletion(async () => sse(events), 'https://api.openai.com/v1/responses', {}, { ...options, stream: true }), (error) => ['provider_unavailable', 'incomplete_stream'].includes(error.code) && !error.message.includes('provider secret'));
  }
});
