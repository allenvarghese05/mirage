import { beforeEach, describe, expect, it } from 'vitest';
import {
  resetDb, getDb, createSession, getSession, setSessionMode, listSessions,
  recordOrder, updateOrder, getOrder, listOrdersForSession,
  upsertBlocklist, getBlocklisted, listBlocklist,
  recordRiskPayload, listRiskPayloads, getPastOrder, addMessage, listMessages,
  insertSimRuns, listSimRuns,
} from './index';
import type { SimRun } from '../../shared/types';

beforeEach(() => resetDb());

describe('db', () => {
  it('uses an in-memory database under vitest and applies the schema', () => {
    const tables = getDb().prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[];
    expect(tables.map((t) => t.name)).toEqual(expect.arrayContaining(['sessions', 'orders', 'blocklist', 'past_orders']));
  });

  it('seeds past_orders with purchase dates relative to now', () => {
    const recent = getPastOrder('NP-10231')!;
    const old = getPastOrder('NP-09877')!;
    expect(recent.customerEmail).toBe('maya.honest@example.com');
    const daysAgo = (iso: string) => (Date.now() - Date.parse(iso)) / 86_400_000;
    expect(Math.round(daysAgo(recent.purchasedAt))).toBe(6);
    expect(Math.round(daysAgo(old.purchasedAt))).toBe(45);
    expect(recent.refunded).toBe(false);
  });

  it('creates sessions with increasing seq and a client metadata id', () => {
    const a = createSession({ storeId: 'northpeak', storeMode: 'mirage' });
    const b = createSession({ storeId: 'driftwood', storeMode: 'baseline', simRunId: 'run-1' });
    expect(b.seq).toBe(a.seq + 1);
    expect(a.clientMetadataId).toMatch(/^[a-f0-9]{32}$/);
    expect(getSession(b.id)).toMatchObject({ storeId: 'driftwood', storeMode: 'baseline', mode: 'normal', simRunId: 'run-1' });
    expect(getSession('nope')).toBeNull();
    setSessionMode(a.id, 'shadow');
    expect(getSession(a.id)!.mode).toBe('shadow');
    expect(listSessions()).toHaveLength(2);
  });

  it('records and updates orders', () => {
    const s = createSession({ storeId: 'northpeak', storeMode: 'mirage' });
    recordOrder({ orderId: 'O1', sessionId: s.id, storeId: 'northpeak', totalCents: 5700, codeUsed: 'X', trapped: true, trapSourceSession: s.id, status: 'AWAITING_APPROVAL' });
    updateOrder('O1', { status: 'PENDING_REVIEW', payerId: 'P1', payer: { payerId: 'P1', name: 'Eve' } });
    const o = getOrder('O1')!;
    expect(o).toMatchObject({ trapped: true, status: 'PENDING_REVIEW', payerId: 'P1', totalCents: 5700, codeUsed: 'X' });
    expect(o.payer).toEqual({ payerId: 'P1', name: 'Eve' });
    expect(listOrdersForSession(s.id)).toHaveLength(1);
    expect(getOrder('missing')).toBeNull();
  });

  it('upserts the blocklist and counts hits', () => {
    upsertBlocklist({ payerId: 'P1', storeId: 'northpeak', sessionId: 's1', reason: 'decoy' });
    upsertBlocklist({ payerId: 'P1', storeId: 'driftwood', sessionId: 's2', reason: 'network' });
    const row = getBlocklisted('P1')!;
    expect(row).toMatchObject({ firstSeenStore: 'northpeak', firstSessionId: 's1', hits: 1 });
    expect(listBlocklist()).toHaveLength(1);
    expect(getBlocklisted('P2')).toBeNull();
  });

  it('stores risk payloads, messages and sim runs', () => {
    recordRiskPayload({ sessionId: 's1', orderId: 'O1', ok: false, httpStatus: 403, body: { a: 1 } });
    expect(listRiskPayloads()[0]).toMatchObject({ ok: false, httpStatus: 403, body: { a: 1 }, orderId: 'O1' });

    addMessage({ sessionId: 's1', role: 'user', content: 'hi' });
    addMessage({ sessionId: 's1', role: 'tool', content: '{}', toolName: 'search_products' });
    expect(listMessages('s1')).toHaveLength(2);
    expect(listMessages('s1', { includeTool: false })).toHaveLength(1);

    const run = { id: 'r1', batchId: 'b1', createdAt: new Date().toISOString() } as SimRun;
    insertSimRuns([run, { ...run, id: 'r2' }]);
    insertSimRuns([{ ...run, technique: 'updated' }]);
    expect(listSimRuns('b1')).toHaveLength(2);
    expect(listSimRuns('b1').find((r) => r.id === 'r1')!.technique).toBe('updated');
  });
});
