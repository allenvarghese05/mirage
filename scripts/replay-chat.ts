// Replays the shopper's exact messages from one stored chat into a NEW session on the same store, so the same attack
// can be shown side by side against the comparison store and Mirage.
// Usage: npx tsx scripts/replay-chat.ts <sourceSessionId> [mirage|baseline] [baseUrl] [maxMessages]
// Costs only store-agent calls (no attacker model). Sim runs need the server started with MIRAGE_SIM=1 only for
// checkout identity; the replay itself only chats.
import { writeFileSync } from 'node:fs';
import { MirageApi } from '../sim/api';

const [src, modeArg = 'mirage', base = 'http://localhost:8791', maxArg] = process.argv.slice(2);
if (!src || !/^s_[\w]+$/.test(src)) {
  console.error('usage: npx tsx scripts/replay-chat.ts <sourceSessionId> [mirage|baseline] [baseUrl] [maxMessages]');
  process.exit(1);
}
const mode = modeArg === 'baseline' ? 'baseline' : 'mirage';
const api = new MirageApi(base);

const source = await api.sessionDetail(src);
const shopperMessages = source.messages.filter((m) => m.role === 'user').map((m) => m.content);
const toSend = maxArg ? shopperMessages.slice(0, Number(maxArg)) : shopperMessages;

const { sessionId, greeting } = await api.createSession({ storeId: source.storeId, storeMode: mode });
console.log(`replaying ${toSend.length} shopper messages from ${src} (${source.storeMode}) into ${sessionId} (${mode}, ${source.storeId})\n`);
console.log(`agent: ${greeting}\n`);

for (const [i, content] of toSend.entries()) {
  console.log(`[${i + 1}] shopper: ${content.replace(/\s+/g, ' ').slice(0, 220)}`);
  const { reply } = await api.sendMessage(sessionId, content);
  console.log(`    agent: ${reply.replace(/\s+/g, ' ').slice(0, 320)}\n`);
}

const detail = await api.sessionDetail(sessionId);
const tools = detail.messages.filter((m) => m.role === 'tool').map((m) => `${m.toolName}: ${m.content.slice(0, 160)}`);
const events = detail.events.map((e) => e.kind);
console.log('tool calls:'); for (const t of tools) console.log('  ' + t);
console.log('events:', events.join(' > ') || '(none)');
console.log(`\nreplay session: ${sessionId}`);
console.log(`watch: /demo?session=${sessionId}&view=split   original: /demo?session=${src}&view=split`);

writeFileSync(`data/replay-${src}-${mode}.json`, JSON.stringify({ source: src, replay: sessionId, mode, storeId: source.storeId, sent: toSend.length, tools, events }, null, 2));
