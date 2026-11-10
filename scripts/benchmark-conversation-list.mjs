// Offline list derivation benchmark: excludes React rendering, browser layout and network.
// node --import ./tests/register.mjs scripts/benchmark-conversation-list.mjs
import { createConversationListSelector } from '../components/studio/companion/conversation-list.ts';

const at = new Date(2026, 10, 10, 12).getTime();
const conversations = Array.from({ length: 50 }, (_, index) => ({ id: `c${index}`, title: `Learning ${index}`, temporary: false, createdAt: at, updatedAt: at - index * 3600000,
  messages: [{ role: 'user', text: 'Review vocabulary today.' }] }));
const edits = Array.from({ length: 142 }, (_, index) => ({ c0: { text: 'a'.repeat(index + 1), quotes: [], attachments: [] } }));

// Reviewed d148c35 ConversationPanel derivation, including date labels previously made on each render.
function before(drafts) {
  const visible = conversations.filter(conversation => !conversation.temporary && (conversation.messages.length > 0 || (conversation.id !== 'c0' && Boolean(drafts[conversation.id]?.text.trim()))));
  const sorted = [...visible].sort((a, b) => b.updatedAt - a.updatedAt);
  const today = new Date().toDateString();
  const groups = [sorted.filter(conversation => new Date(conversation.updatedAt).toDateString() === today), sorted.filter(conversation => new Date(conversation.updatedAt).toDateString() !== today)];
  return groups.flatMap(items => items.map(conversation => ({ title: conversation.title, label: conversation.id === 'c0' ? '当前' : new Date(conversation.updatedAt).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' }) })));
}
const select = createConversationListSelector();
select(conversations, edits[0], 'c0');
const after = drafts => select(conversations, drafts, 'c0');
for (let run = 0; run < 2; run++) { before(edits[0]); after(edits[0]); }
const timings = { before: [], after: [] };
let rows = 0;
for (let run = 0; run < 9; run++) {
  for (const label of run % 2 ? ['after', 'before'] : ['before', 'after']) {
    const start = performance.now();
    for (const drafts of edits) rows += (label === 'before' ? before : after)(drafts).length;
    timings[label].push(performance.now() - start);
  }
}
const median = values => [...values].sort((a, b) => a - b)[4];
console.log(JSON.stringify({ baseline: 'd148c35', node: process.version, measuredAt: new Date().toISOString(), scope: 'Saved-conversation list derivation only, warm cache, 50 conversations and 142 active-draft edits; excludes React rendering, browser layout and network', samples: 9, beforeMedianMs: median(timings.before), afterMedianMs: median(timings.after), rowsConsumed: rows }, null, 2));
