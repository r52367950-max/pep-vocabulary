import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { chromium } from '/opt/codex/runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';

// Exercise the actual app and NativeLiveSession with controlled WebRTC/media/HTTP
// adapters. No real microphone, provider, paid session or production account.
const base = process.env.CIJI_QA_URL || 'http://127.0.0.1:5174';
const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const checks = [], errors = [];
const filter = process.env.LIVE_VOICE_QA_FILTER || '';
const note = (name, detail = {}) => { checks.push({ name, status: 'passed', ...detail }); console.log(`PASS ${name}`); };

async function fixture() {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN', reducedMotion: 'reduce' });
  const state = { scope: 'voice-account-a', revision: 1, sessions: [], closes: [], tools: [], chats: [], speeches: [], holdMemory: false, held: [] };
  await context.route('**/api/learning-memory**', async route => {
    if (state.holdMemory) await new Promise(resolve => state.held.push(resolve));
    try { await route.fulfill({ json: { accountScope: state.scope, revision: state.revision, enabled: true, notes: [], recentTopics: [], model: 'gpt-6.1-sol', contextVersion: 'voice-v1', journalRevision: 0 } }); } catch { /* aborted start */ }
  });
  await context.route('**/api/learning-journal**', route => route.fulfill({ json: { accountScope: state.scope, enabled: false, revision: 1, privacyRevision: 1, days: [] } }));
  await context.route('**/api/assistant/chat', async route => { const body = route.request().postDataJSON(); state.chats.push(body); await route.fulfill({ json: { ok: true, result: { text: '继续解释刚才的内容。', actions: [] }, model: 'gpt-6.1-sol', effort: 'medium', accountScope: body.accountScope, contextRevision: body.contextRevision, contextVersion: body.contextVersion } }); });
  await context.route('**/api/voice/status', route => route.fulfill({ json: { configured: true, ready: true, models: { voice: 'live-fixture', text: 'gpt-6.1-sol' }, activeSession: null, remainingSeconds: 3600 } }));
  await context.route('**/api/voice/session', async route => {
    state.sessions.push(route.request().postDataJSON());
    await route.fulfill({ json: { sessionId: `sess_fixture_${state.sessions.length}`, sdp: 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n', model: 'live-fixture', maxSeconds: 600 } });
  });
  await context.route('**/api/voice/close', async route => { state.closes.push(route.request().postDataJSON()); await route.fulfill({ json: { ok: true } }); });
  await context.route('**/api/voice/speech', async route => { state.speeches.push(route.request().postDataJSON()); await route.fulfill({ status: 503, json: { error: { message: '语音服务暂不可用' } } }); });
  await context.route('**/api/voice/learning-tool', async route => {
    const body = route.request().postDataJSON(); state.tools.push(body);
    await route.fulfill({ json: { items: [{ id: 'fixture-practice', mode: 'words', text: 'practice', hint: '练习', source: 'QA fixture' }], reason: '复习刚才提到的词', clarification: '', accountScope: body.accountScope, contextRevision: body.contextRevision, contextVersion: body.contextVersion, temporary: !!body.temporary } });
  });
  await context.addInitScript(() => {
    const qa = { peers: [], tracks: [], mediaCalls: 0, sent: [], autoClose: true, speechCalls: 0 };
    window.__liveQA = qa;
    class FakePeer extends EventTarget {
      constructor() { super(); this.iceGatheringState = 'complete'; this.connectionState = 'new'; this.channel = null; qa.peers.push(this); }
      addTrack() {}
      createDataChannel() {
        return this.channel = { readyState: 'open', onmessage: null, onclose: null,
          send: raw => { const event = JSON.parse(raw); qa.sent.push(event); if (event.type === 'session.close' && qa.autoClose) setTimeout(() => this.emit({ type: 'session.closed', usage: { seconds: 1 } }), 5); },
          close() { this.readyState = 'closed'; },
        };
      }
      createOffer() { return Promise.resolve({ type: 'offer', sdp: 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n' }); }
      setLocalDescription(description) { this.localDescription = description; return Promise.resolve(); }
      setRemoteDescription() { this.connectionState = 'connected'; setTimeout(() => this.emit({ type: 'session.started' }), 0); return Promise.resolve(); }
      close() { this.connectionState = 'closed'; }
      emit(event) { this.channel?.onmessage?.({ data: JSON.stringify(event) }); }
    }
    window.RTCPeerConnection = FakePeer;
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { async getUserMedia() {
      qa.mediaCalls++;
      const track = { enabled: true, stopped: false, stop() { this.stopped = true; } }; qa.tracks.push(track);
      return { getTracks: () => [track], getAudioTracks: () => [track] };
    } } });
    Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: {
      speaking: false, cancel() {}, getVoices() { return []; },
      speak(utterance) { qa.speechCalls++; queueMicrotask(() => { utterance.onstart?.(); setTimeout(() => utterance.onend?.(), 10); }); },
      addEventListener() {}, removeEventListener() {},
    } });
    qa.emit = (event, index = qa.peers.length - 1) => qa.peers[index]?.emit(event);
  });
  const page = await context.newPage();
  page.setDefaultTimeout(12_000);
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.locator('.daily-feature').waitFor({ timeout: 60_000 });
  const nav = page.getByRole('button', { name: 'AI 对话', exact: true });
  for (const button of await nav.all()) if (await button.isVisible()) { await button.click(); break; }
  await page.locator('.ciji-companion .greeting').waitFor();
  return { page, context, state };
}
async function openVoice(page) { await page.getByRole('button', { name: '语音会话', exact: true }).click(); await page.locator('.live-voice-stage').waitFor(); await page.waitForFunction(() => !document.querySelector('[aria-label="开始语音"]')?.disabled); }
async function start(page) { await page.getByRole('button', { name: '开始语音', exact: true }).click(); await page.getByText('对话进行中', { exact: true }).waitFor(); }
async function emit(page, event) { await page.evaluate(event => window.__liveQA.emit(event), event); }
async function captions(page, first, second = '我听到了，继续。') {
  await emit(page, { type: 'session.input_transcript.delta', delta: first, start_ms: 0, end_ms: 100 });
  await emit(page, { type: 'session.output_transcript.delta', delta: second, start_ms: 150, end_ms: 300 });
  await page.locator('.voice-captions').getByText(first, { exact: true }).waitFor();
}
async function closeVoice(page) { await page.getByRole('button', { name: '结束语音会话', exact: true }).click(); await page.locator('.live-voice-stage').waitFor({ state: 'detached' }); }
async function media(page) { return page.evaluate(() => ({ calls: window.__liveQA.mediaCalls, stopped: window.__liveQA.tracks.every(track => track.stopped), peersClosed: window.__liveQA.peers.every(peer => peer.connectionState === 'closed') })); }
async function run(name, work) {
  if (filter && !filter.split('|').some(term => name.includes(term))) return;
  const f = await fixture();
  try { await work(f); note(name); }
  finally { f.state.holdMemory = false; f.state.held.splice(0).forEach(resolve => resolve()); await f.context.close(); }
}

let failure;
try {
  await run('Natural end and restart retain each transcript once, and restart receives prior voice context', async ({ page, state }) => {
    await openVoice(page); await start(page); await captions(page, 'FIRST_VOICE_173');
    await emit(page, { type: 'session.closed', usage: { seconds: 2 } });
    await page.getByRole('button', { name: '开始语音', exact: true }).waitFor();
    await page.waitForFunction(() => !document.querySelector('[aria-label="开始语音"]')?.disabled);
    await start(page);
    assert.ok(state.sessions[1].openingPrompt.includes('FIRST_VOICE_173'));
    await captions(page, 'SECOND_VOICE_274');
    await closeVoice(page);
    assert.equal(await page.locator('.voice-card').count(), 2);
    const text = await page.locator('.thread').innerText();
    assert.equal(text.split('FIRST_VOICE_173').length - 1, 1);
    assert.equal(text.split('SECOND_VOICE_274').length - 1, 1);
    assert.deepEqual(await media(page), { calls: 2, stopped: true, peersClosed: true });
  });
  await run('Finishing while account context is pending cancels startup before requesting microphone', async ({ page, state }) => {
    await openVoice(page);
    state.holdMemory = true;
    await page.getByRole('button', { name: '开始语音', exact: true }).click();
    await page.waitForTimeout(100);
    assert.ok(state.held.length > 0);
    await closeVoice(page);
    state.holdMemory = false; state.held.splice(0).forEach(resolve => resolve());
    await page.waitForTimeout(250);
    assert.equal((await media(page)).calls, 0);
    assert.equal(state.sessions.length, 0);
  });
  await run('Account invalidation rejects late old-session captions and stops every track', async ({ page, state }) => {
    await openVoice(page); await start(page); await captions(page, 'OLD_ACCOUNT_VOICE');
    state.scope = 'voice-account-b';
    await page.evaluate(() => {
      window.__liveQA.autoClose = false;
      window.dispatchEvent(new Event('vocab-ai-config-changed'));
      window.__liveQA.emit({ type: 'session.output_transcript.delta', delta: 'LATE_OLD_ACCOUNT_SECRET', start_ms: 400, end_ms: 500 });
    });
    await page.waitForTimeout(300);
    assert.equal(await page.getByText(/LATE_OLD_ACCOUNT_SECRET/).count(), 0);
    assert.equal((await media(page)).stopped, true);
    await page.waitForTimeout(1600);
    const saved = await page.evaluate(() => JSON.stringify(Object.fromEntries(Object.keys(localStorage).filter(key => key.startsWith('vocab-companion-history')).map(key => [key, localStorage.getItem(key)]))));
    assert.ok(!saved.includes('LATE_OLD_ACCOUNT_SECRET'));
  });
  await run('Temporary voice stays in memory and sends the temporary scope', async ({ page, state }) => {
    await page.getByRole('button', { name: '开始临时对话', exact: true }).click();
    await openVoice(page); await start(page); await captions(page, 'TEMP_VOICE_SECRET_381'); await closeVoice(page);
    assert.equal(state.sessions[0].temporary, true);
    assert.equal(await page.locator('.voice-card').count(), 1);
    await page.waitForTimeout(450);
    const saved = await page.evaluate(() => JSON.stringify(Object.fromEntries(Object.keys(localStorage).filter(key => key.startsWith('vocab-companion-history')).map(key => [key, localStorage.getItem(key)]))));
    assert.ok(!saved.includes('TEMP_VOICE_SECRET_381'));
    assert.equal((await media(page)).stopped, true);
  });
  await run('Typed follow-up after voice includes each captured turn once in the real chat request', async ({ page, state }) => {
    await openVoice(page); await start(page); await captions(page, 'VOICE_USER_CONTEXT_491', 'VOICE_ASSISTANT_CONTEXT_592');
    await page.getByRole('textbox', { name: '用文字提问', exact: true }).fill('继续解释刚才那句');
    await page.getByRole('button', { name: '发送文字并返回对话', exact: true }).click();
    await page.locator('.live-voice-stage').waitFor({ state: 'detached' });
    await page.locator('.ai-turn[aria-busy="false"]').waitFor();
    assert.equal(state.chats.length, 1);
    const sent = state.chats[0].messages;
    assert.equal(sent.filter(turn => turn.role === 'user' && turn.text.includes('VOICE_USER_CONTEXT_491')).length, 1);
    assert.equal(sent.filter(turn => turn.role === 'assistant' && turn.text.includes('VOICE_ASSISTANT_CONTEXT_592')).length, 1);
    assert.equal(sent.at(-1).text, '继续解释刚才那句');
    assert.equal(await page.locator('.voice-card').count(), 1);
    assert.equal((await media(page)).stopped, true);
  });
  await run('Live tool prepares actual dictation, grades an answer and returns the result to the same conversation', async ({ page, state }) => {
    await openVoice(page); await start(page); await captions(page, '帮我听写 practice。');
    const delegation = 'delegation_qa', responseId = 'response_qa';
    await emit(page, { type: 'session.delegation.created', delegation: { id: delegation, target: 'responses' } });
    await emit(page, { type: 'response.event', delegation_id: delegation, event: { type: 'response.created', response: { id: responseId } } });
    await emit(page, { type: 'response.event', delegation_id: delegation, event: { type: 'response.output_item.done', response_id: responseId, item: { type: 'function_call', call_id: 'call_qa', name: 'prepare_dictation', arguments: JSON.stringify({ request: 'practice' }) } } });
    await emit(page, { type: 'response.event', delegation_id: delegation, event: { type: 'response.completed', response: { id: responseId } } });
    await page.getByRole('button', { name: '开始准备好的听写 · 1 项', exact: true }).click();
    assert.equal(state.tools.length, 1);
    assert.equal((await media(page)).stopped, true);
    await page.locator('.live-dictation-stage').waitFor();
    await page.locator('.live-dictation-stage').getByRole('button', { name: /^开始听写/ }).click();
    await page.getByRole('button', { name: '播放音频', exact: true }).click();
    await page.getByRole('textbox', { name: '写下听到的词或短语', exact: true }).fill('practice');
    await page.getByRole('button', { name: '核对答案', exact: true }).click();
    await page.getByText('听写正确', { exact: true }).waitFor();
    await page.getByRole('button', { name: '返回对话', exact: true }).click();
    await page.locator('.voice-card').waitFor();
    const text = await page.locator('.voice-card').innerText();
    assert.match(text, /帮我听写 practice/);
    assert.match(text, /完成 1 次作答，独立答对 1 次/);
    assert.equal(await page.locator('.voice-card').count(), 1);
  });
  await run('Temporary dictation uses the real request scope and recovers from AI speech failure', async ({ page, state }) => {
    await page.getByRole('button', { name: '开始临时对话', exact: true }).click();
    await openVoice(page); await start(page); await captions(page, 'TEMP_DICTATION_SECRET_684');
    const delegation = 'delegation_temp_qa', responseId = 'response_temp_qa';
    await emit(page, { type: 'session.delegation.created', delegation: { id: delegation, target: 'responses' } });
    await emit(page, { type: 'response.event', delegation_id: delegation, event: { type: 'response.created', response: { id: responseId } } });
    await emit(page, { type: 'response.event', delegation_id: delegation, event: { type: 'response.output_item.done', response_id: responseId, item: { type: 'function_call', call_id: 'call_temp_qa', name: 'prepare_dictation', arguments: JSON.stringify({ request: 'practice' }) } } });
    await emit(page, { type: 'response.event', delegation_id: delegation, event: { type: 'response.completed', response: { id: responseId } } });
    await page.getByRole('button', { name: '开始准备好的听写 · 1 项', exact: true }).click();
    assert.equal(state.tools[0].temporary, true);
    await page.locator('.live-dictation-stage').getByRole('button', { name: /^开始听写/ }).click();
    await page.getByRole('combobox', { name: '朗读方式' }).selectOption('ai');
    await page.getByRole('button', { name: '播放音频', exact: true }).click();
    await page.getByText('语音服务暂不可用。可改用设备朗读。', { exact: true }).waitFor();
    assert.equal(state.speeches.length, 1);
    assert.equal(state.speeches[0].temporary, true);
    assert.equal(state.speeches[0].accountScope, state.scope);
    assert.equal(await page.getByRole('button', { name: '播放音频', exact: true }).getAttribute('aria-busy'), 'false');
    await page.getByRole('combobox', { name: '朗读方式' }).selectOption('device');
    await page.getByRole('button', { name: '播放音频', exact: true }).click();
    await page.getByRole('textbox', { name: '写下听到的词或短语', exact: true }).fill('practice');
    await page.getByRole('button', { name: '核对答案', exact: true }).click();
    await page.getByText('听写正确', { exact: true }).waitFor();
    await page.getByRole('button', { name: '返回对话', exact: true }).click();
    await page.locator('.voice-card').waitFor();
    assert.match(await page.locator('.voice-card').innerText(), /完成 1 次作答，独立答对 1 次/);
    const saved = await page.evaluate(() => JSON.stringify(Object.fromEntries(Object.keys(localStorage).filter(key => key.startsWith('vocab-companion-history')).map(key => [key, localStorage.getItem(key)]))));
    assert.ok(!saved.includes('TEMP_DICTATION_SECRET_684'));
    assert.equal((await media(page)).stopped, true);
  });
  assert.deepEqual(errors, []);
} catch (error) { failure = error; console.error(error.stack || error); }
finally {
  await writeFile(new URL(filter ? './live-voice-browser-targeted.json' : './live-voice-browser.json', import.meta.url), JSON.stringify({ status: failure ? 'failed' : 'passed', browser: await browser.version(), base, filter: filter || null, checks, pageErrors: errors, failure: failure ? String(failure.stack || failure) : null, limits: ['Actual browser, React integration and NativeLiveSession code exercised with fake RTCPeerConnection, tracks and speech synthesis.', 'Account/context/voice HTTP uses deterministic fixtures; no real mic, provider, quota spend or voice latency measurement.'] }, null, 2) + '\n');
  await browser.close();
}
if (failure) process.exitCode = 1;
