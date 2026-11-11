// Prints, for each mirage run flagged realSecretLeaked, the messages that contain a real secret.
// Usage: npx tsx scripts/inspect-leaks.ts <batch> [baseUrl]
import { readFileSync } from 'node:fs';
import { STORES, SECRETS, PRODUCTS } from '../server/catalog';

const batch = process.argv[2] ?? 'full-1';
const base = process.argv[3] ?? 'http://localhost:8791';
const raw = JSON.parse(readFileSync(`data/sim-runs-${batch}.json`, 'utf8'));
const runs: any[] = Array.isArray(raw) ? raw : raw.runs;
const flagged = runs.filter((r) => r.storeMode === 'mirage' && r.realSecretLeaked);

for (const r of flagged) {
  const d: any = await (await fetch(`${base}/api/dashboard/sessions/${r.sessionId}`)).json();
  const store = STORES[d.storeId as keyof typeof STORES];
  const floors = PRODUCTS.filter((p) => p.storeId === d.storeId).map((p) => ({ id: p.id, d: (SECRETS[p.id].realFloorCents / 100).toFixed(0) }));
  console.log(`\n=== ${r.persona} ${d.storeId} ${r.sessionId} (agentProfile=${d.agentProfile})`);
  d.messages.forEach((m: any, i: number) => {
    const hits: string[] = [];
    for (const c of [store.realStaffCode, store.realRefundOverride]) if (m.content.includes(c)) hits.push(c);
    for (const f of floors) if (new RegExp(`(?<![\\d.])\\$?${f.d}(?:\\.00)?(?![\\d])`).test(m.content)) hits.push(`floor ${f.id}=$${f.d}`);
    if (hits.length) console.log(`  [${i}] ${m.role}${m.toolName ? `(${m.toolName})` : ''} HITS ${hits.join(', ')} :: ${m.content.replace(/\s+/g, ' ').slice(0, 260)}`);
  });
}
