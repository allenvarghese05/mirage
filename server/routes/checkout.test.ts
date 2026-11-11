import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SECRETS } from '../catalog';
import { createCheckoutRouter, MESSAGES } from './checkout';
import { addSession, kinds, makeTestDeps, type TestDeps } from '../paypal/test-helpers';

const PENDING = 'Thanks — your order has been received and is pending review. You have not been charged.';
const DEV = { payerId: 'DEVPAYER01', name: 'Dev Patel', email: 'dev@example.com', countryCode: 'US' };
const HONEST = { payerId: 'MAYAPAYER1', name: 'Maya Honest', email: 'maya@example.com', countryCode: 'US' };

let d: TestDeps;
let app: express.Express;

function build(cfg: Parameters<typeof makeTestDeps>[0] = {}) {
  d = makeTestDeps(cfg);
  app = express();
  app.set('trust proxy', true);

  app.use(createCheckoutRouter(() => d));
}

const checkout = (body: object, headers: Record<string, string> = {}) => {
  let r = request(app).post('/api/checkout');
  for (const [k, v] of Object.entries(headers)) r = r.set(k, v);
  return r.send(body);
};
const approved = (orderId: string, body: object) => request(app).post(`/api/checkout/${orderId}/approved`).send(body);
const orderRow = (orderId: string) => d.db.prepare('SELECT * FROM orders WHERE order_id = ?').get(orderId) as any;

beforeEach(() => {
  build();
  addSession(d.db, { id: 's1', storeId: 'northpeak' });
  addSession(d.db, { id: 's0', storeId: 'northpeak' });
  addSession(d.db, { id: 'dw1', storeId: 'driftwood' });
  addSession(d.db, { id: 'base1', storeId: 'northpeak', storeMode: 'baseline' });
  d.codes.set('NP-STAFF-00A7-K9MD', { sessionId: 's1', kind: 'staff_code' });
  d.codes.set('NP-MGR-00A1-Q2XF', { sessionId: 's0', kind: 'refund_override' });
});

describe('POST /api/checkout', () => {
  it('creates an honest order at list price, tagged for PayPal', async () => {
    const r = await checkout({ sessionId: 's1', items: [{ productId: 'np-jacket', qty: 1 }, { productId: 'np-beanie', qty: 2 }] });
    expect(r.status).toBe(200);
    expect(r.body.totalCents).toBe(9500 + 2 * 2800);
    expect(r.body.discountLabel).toBeUndefined();
    expect(new URL(r.body.approveUrl).hostname).toBe('www.sandbox.paypal.com');
    const params = d.pp.orders.get(r.body.orderId)!.params;
    expect(params.customId).toMatch(/^mirage:s1:/);
    expect(params.clientMetadataId).toBe('cmid-s1');
    expect(params.totalCents).toBe(15100);
    expect(orderRow(r.body.orderId)).toMatchObject({ session_id: 's1', store_id: 'northpeak', trapped: 0, status: 'AWAITING_APPROVAL', total_cents: 15100 });
    expect(d.events).toHaveLength(0);
  });

  it('uses the agreed quote, but never below the real floor', async () => {
    d.db.prepare("INSERT INTO quotes VALUES ('s1', 'np-jacket', 8000, 'now'), ('s1', 'np-boots', 100, 'now')").run();
    const r = await checkout({ sessionId: 's1', items: [{ productId: 'np-jacket', qty: 1 }, { productId: 'np-boots', qty: 1 }] });
    expect(r.body.totalCents).toBe(8000 + SECRETS['np-boots'].realFloorCents);
  });

  it('a decoy code shows the discount, but the order is trapped server-side and attributed', async () => {
    const r = await checkout({ sessionId: 's1', items: [{ productId: 'np-jacket', qty: 1 }], code: ' np-staff-00a7-k9md ' });
    expect(r.status).toBe(200);
    expect(r.body.totalCents).toBe(5700);
    expect(r.body.discountLabel).toBe('Staff pricing (40% off)');
    expect(orderRow(r.body.orderId)).toMatchObject({ trapped: 1, code_used: 'NP-STAFF-00A7-K9MD', trap_source_session: 's1' });
    const ev = d.events.find((e) => e.kind === 'DECOY_REDEEMED')!;
    expect(ev.severity).toBe('critical');
    expect(ev.detail).toMatchObject({ decoyCode: 'NP-STAFF-00A7-K9MD', decoyKind: 'staff_code', sourceSessionId: 's1', attributedToSelf: true, orderId: r.body.orderId, amountCents: 5700 });
    await vi.waitFor(() => expect(kinds(d)).toContain('RISK_SIGNAL_SENT'));
    expect(d.pp.riskCalls[0].clientMetadataId).toBe('cmid-s1');
  });

  it('a decoy checkout does not wait on the risk call (no timing tell)', async () => {
    let release!: () => void;
    d.pp.putRiskContext = () => new Promise((r) => { release = () => r({ ok: false, status: 403 }); });
    const r = await checkout({ sessionId: 's1', items: [{ productId: 'np-jacket', qty: 1 }], code: 'NP-STAFF-00A7-K9MD' });
    expect(r.status).toBe(200);
    expect(kinds(d)).not.toContain('RISK_SIGNAL_SENT');
    release();
    await vi.waitFor(() => expect(kinds(d)).toContain('RISK_SIGNAL_SENT'));
  });

  it('a decoy leaked from another session is a spread edge (not self-attributed)', async () => {
    const r = await checkout({ sessionId: 'dw1', items: [{ productId: 'dw-grinder', qty: 1 }], code: 'NP-MGR-00A1-Q2XF' });
    expect(r.body.totalCents).toBe(Math.round(8900 * 0.65));
    const ev = d.events.find((e) => e.kind === 'DECOY_REDEEMED')!;
    expect(ev.sessionId).toBe('dw1');
    expect(ev.storeId).toBe('driftwood');
    expect(ev.detail).toMatchObject({ sourceSessionId: 's0', attributedToSelf: false, decoyKind: 'refund_override' });
  });

  it('the real staff code works in baseline mode only', async () => {
    const base = await checkout({ sessionId: 'base1', items: [{ productId: 'np-jacket', qty: 1 }], code: 'NP-CREW-2291' });
    expect(base.body).toMatchObject({ totalCents: 5700, discountLabel: 'Staff pricing (40% off)' });
    expect(orderRow(base.body.orderId).trapped).toBe(0);
    const mir = await checkout({ sessionId: 's1', items: [{ productId: 'np-jacket', qty: 1 }], code: 'NP-CREW-2291' });
    expect(mir.body.totalCents).toBe(9500);
    expect(mir.body.discountLabel).toBeUndefined();
    expect(d.events).toHaveLength(0);
  });

  it('an unknown code is ignored', async () => {
    const r = await checkout({ sessionId: 's1', items: [{ productId: 'np-jacket', qty: 1 }], code: 'SAVE50' });
    expect(r.status).toBe(200);
    expect(r.body.totalCents).toBe(9500);
    expect(r.body.discountLabel).toBeUndefined();
    expect(d.events).toHaveLength(0);
  });

  it('validates the request', async () => {
    expect((await checkout({ sessionId: 'nope', items: [{ productId: 'np-jacket', qty: 1 }] })).status).toBe(404);
    expect((await checkout({ sessionId: 's1', items: [{ productId: 'dw-kettle', qty: 1 }] })).status).toBe(400);
    expect((await checkout({ sessionId: 's1', items: [{ productId: 'np-jacket', qty: 0 }] })).status).toBe(400);
    expect((await checkout({ sessionId: 's1', items: [{ productId: 'np-jacket', qty: 1.5 }] })).status).toBe(400);
    expect((await checkout({ sessionId: 's1', items: [] })).status).toBe(400);
    expect((await checkout({ sessionId: 's1' })).status).toBe(400);
  });

  it('traps an order from the same public client as a blocklisted session', async () => {
    addSession(d.db, { id: 'bad', ip: '203.0.113.9', userAgent: 'Firefox' });
    d.db.prepare("INSERT INTO blocklist VALUES ('P1', 'northpeak', 'bad', 'decoy', 0, 'now')").run();
    addSession(d.db, { id: 'again', storeId: 'driftwood', ip: '203.0.113.9', userAgent: 'Firefox' });
    const r = await checkout({ sessionId: 'again', items: [{ productId: 'dw-beans', qty: 1 }] });
    expect(r.body.discountLabel).toBeUndefined();
    expect(orderRow(r.body.orderId)).toMatchObject({ trapped: 1, trap_source_session: 'bad' });
    expect(d.events.find((e) => e.kind === 'NETWORK_MATCH')!.detail).toMatchObject({ via: 'client_fingerprint', matchedSessionId: 'bad' });
  });

  it('falls back to the request ip and user agent when the session has none', async () => {
    addSession(d.db, { id: 'bad', ip: '203.0.113.9', userAgent: 'Firefox' });
    d.db.prepare("INSERT INTO blocklist VALUES ('P1', 'northpeak', 'bad', 'decoy', 0, 'now')").run();
    const r = await checkout({ sessionId: 's1', items: [{ productId: 'np-beanie', qty: 1 }] }, { 'X-Forwarded-For': '203.0.113.9', 'User-Agent': 'Firefox' });
    expect(orderRow(r.body.orderId).trapped).toBe(1);
  });

  it('sim sessions get SIM- orders from the in-process PayPal when MIRAGE_SIM=1', async () => {
    build({ sim: true });
    addSession(d.db, { id: 'sim1', simRunId: 'run1' });
    addSession(d.db, { id: 'web1' });
    const sim = await checkout({ sessionId: 'sim1', items: [{ productId: 'np-beanie', qty: 1 }] });
    expect(sim.body.orderId).toMatch(/^SIM-/);
    const real = await checkout({ sessionId: 'sim1', items: [{ productId: 'np-beanie', qty: 1 }] }, { 'X-Mirage-Real-PayPal': '1' });
    expect(real.body.orderId).not.toMatch(/^SIM-/);
    const web = await checkout({ sessionId: 'web1', items: [{ productId: 'np-beanie', qty: 1 }] });
    expect(web.body.orderId).not.toMatch(/^SIM-/);
  });

  it('sim sessions use real PayPal when MIRAGE_SIM is off', async () => {
    addSession(d.db, { id: 'sim1', simRunId: 'run1' });
    const r = await checkout({ sessionId: 'sim1', items: [{ productId: 'np-beanie', qty: 1 }] });
    expect(r.body.orderId).not.toMatch(/^SIM-/);
  });

  it('503s when PayPal keys are missing (non-sim)', async () => {
    build({ hasPaypalKeys: false });
    addSession(d.db, { id: 's1' });
    expect((await checkout({ sessionId: 's1', items: [{ productId: 'np-beanie', qty: 1 }] })).status).toBe(503);
  });
});

describe('POST /api/checkout/:orderId/approved', () => {
  async function newOrder(sessionId: string, items: object[], code?: string) {
    const r = await checkout({ sessionId, items, code });
    expect(r.status).toBe(200);
    return r.body.orderId as string;
  }

  it('captures an honest order and stores the payer', async () => {
    const id = await newOrder('s1', [{ productId: 'np-jacket', qty: 1 }]);
    d.pp.approve(id, HONEST);
    const r = await approved(id, { sessionId: 's1' });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ orderId: id, status: 'COMPLETED', message: MESSAGES.COMPLETED });
    expect(d.pp.captures).toHaveLength(1);
    expect(orderRow(id)).toMatchObject({ status: 'COMPLETED', payer_id: 'MAYAPAYER1', capture_id: d.pp.captures[0].captureId });
    expect(JSON.parse(orderRow(id).payer_json)).toMatchObject(HONEST);
    expect(d.events).toHaveLength(0);
  });

  it('never captures a trapped order: identity captured, payer blocklisted, order held', async () => {
    const id = await newOrder('s1', [{ productId: 'np-jacket', qty: 1 }], 'NP-STAFF-00A7-K9MD');
    d.events.length = 0;
    d.pp.riskCalls.length = 0;
    d.pp.approve(id, DEV);
    const r = await approved(id, { sessionId: 's1' });
    expect(r.body).toEqual({ orderId: id, status: 'PENDING_REVIEW', message: PENDING });
    expect(d.pp.captures).toHaveLength(0);
    expect(orderRow(id)).toMatchObject({ status: 'PENDING_REVIEW', payer_id: 'DEVPAYER01', capture_id: null });
    expect(d.db.prepare('SELECT * FROM blocklist').all()).toMatchObject([{ payer_id: 'DEVPAYER01', first_seen_store: 'northpeak', first_session_id: 's1', reason: 'decoy:staff_code' }]);
    await vi.waitFor(() => expect(kinds(d)).toEqual(['IDENTITY_CAPTURED', 'ORDER_HELD', 'RISK_SIGNAL_SENT']));
    expect(d.events[0].detail).toMatchObject({ payerId: 'DEVPAYER01', name: 'Dev Patel', email: 'dev@example.com', orderId: id, decoyCode: 'NP-STAFF-00A7-K9MD', sourceSessionId: 's1' });
    expect(d.events[0].severity).toBe('critical');
    expect(d.pp.riskCalls[0].body).toMatchObject({ additional_data: expect.arrayContaining([{ key: 'sender_account_id', value: 'DEVPAYER01' }]) });
  });

  it('a blocklisted payer is caught at the second store (NETWORK_MATCH), even with no code', async () => {
    const trap = await newOrder('s1', [{ productId: 'np-jacket', qty: 1 }], 'NP-STAFF-00A7-K9MD');
    d.pp.approve(trap, DEV);
    await approved(trap, { sessionId: 's1' });
    d.events.length = 0;

    const id = await newOrder('dw1', [{ productId: 'dw-kettle', qty: 1 }]);
    d.pp.approve(id, DEV);
    const r = await approved(id, { sessionId: 'dw1' });
    expect(r.body.status).toBe('PENDING_REVIEW');
    expect(r.body.message).toBe(PENDING);
    expect(d.pp.captures).toHaveLength(0);
    const nm = d.events.find((e) => e.kind === 'NETWORK_MATCH')!;
    expect(nm).toMatchObject({ severity: 'critical', storeId: 'driftwood', sessionId: 'dw1' });
    expect(nm.detail).toMatchObject({ via: 'payer', payerId: 'DEVPAYER01', firstSeenStore: 'northpeak', firstSessionId: 's1', orderId: id });
    expect(kinds(d)).toEqual(expect.arrayContaining(['NETWORK_MATCH', 'IDENTITY_CAPTURED', 'ORDER_HELD']));
    expect(orderRow(id)).toMatchObject({ trapped: 1, trap_source_session: 's1' });
    expect((d.db.prepare("SELECT hits FROM blocklist WHERE payer_id = 'DEVPAYER01'").get() as any).hits).toBe(1);
  });

  it('reports AWAITING_APPROVAL while the buyer has not approved', async () => {
    const id = await newOrder('s1', [{ productId: 'np-jacket', qty: 1 }]);
    const r = await approved(id, { sessionId: 's1' });
    expect(r.body).toEqual({ orderId: id, status: 'AWAITING_APPROVAL', message: MESSAGES.AWAITING_APPROVAL });
    expect(d.pp.captures).toHaveLength(0);
  });

  it('is idempotent: repeated and concurrent approvals capture once and emit once', async () => {
    const honest = await newOrder('s1', [{ productId: 'np-jacket', qty: 1 }]);
    d.pp.approve(honest, HONEST);
    await Promise.all([approved(honest, { sessionId: 's1' }), approved(honest, { sessionId: 's1' }), approved(honest, { sessionId: 's1' })]);
    expect(d.pp.captures).toHaveLength(1);

    const trap = await newOrder('s1', [{ productId: 'np-jacket', qty: 1 }], 'NP-STAFF-00A7-K9MD');
    d.events.length = 0;
    d.pp.approve(trap, DEV);
    const rs = await Promise.all([approved(trap, { sessionId: 's1' }), approved(trap, { sessionId: 's1' })]);
    await approved(trap, { sessionId: 's1' });
    expect(rs.map((r) => r.body.status)).toEqual(['PENDING_REVIEW', 'PENDING_REVIEW']);
    expect(kinds(d).filter((k) => k === 'IDENTITY_CAPTURED')).toHaveLength(1);
  });

  it('404s for an unknown order or the wrong session', async () => {
    const id = await newOrder('s1', [{ productId: 'np-jacket', qty: 1 }]);
    expect((await approved('NOPE', { sessionId: 's1' })).status).toBe(404);
    expect((await approved(id, { sessionId: 's0' })).status).toBe(404);
  });

  it('honours simulatedPayer only for SIM- orders of sim sessions with MIRAGE_SIM=1', async () => {
    build({ sim: true });
    addSession(d.db, { id: 'sim1', simRunId: 'run1' });
    d.codes.set('NP-STAFF-00A7-K9MD', { sessionId: 'sim1', kind: 'staff_code' });
    const trap = (await checkout({ sessionId: 'sim1', items: [{ productId: 'np-jacket', qty: 1 }], code: 'NP-STAFF-00A7-K9MD' })).body.orderId;
    const r = await approved(trap, { sessionId: 'sim1', simulatedPayer: DEV });
    expect(r.body.status).toBe('PENDING_REVIEW');
    expect(orderRow(trap).payer_id).toBe('DEVPAYER01');
    const honest = (await checkout({ sessionId: 'sim1', items: [{ productId: 'np-beanie', qty: 1 }] })).body.orderId;
    expect((await approved(honest, { sessionId: 'sim1', simulatedPayer: HONEST })).body.status).toBe('COMPLETED');
    expect(d.sim.captures).toHaveLength(1);
    expect(d.pp.captures).toHaveLength(0);
  });

  it('ignores simulatedPayer on real orders, and when MIRAGE_SIM is off', async () => {
    build({ sim: true });
    addSession(d.db, { id: 'sim1', simRunId: 'run1' });
    const real = (await checkout({ sessionId: 'sim1', items: [{ productId: 'np-beanie', qty: 1 }] }, { 'X-Mirage-Real-PayPal': '1' })).body.orderId;
    expect((await approved(real, { sessionId: 'sim1', simulatedPayer: HONEST })).body.status).toBe('AWAITING_APPROVAL');

    build({ sim: false });
    addSession(d.db, { id: 'sim2', simRunId: 'run2' });
    const id = (await checkout({ sessionId: 'sim2', items: [{ productId: 'np-beanie', qty: 1 }] })).body.orderId;
    expect((await approved(id, { sessionId: 'sim2', simulatedPayer: HONEST })).body.status).toBe('AWAITING_APPROVAL');
  });

  it('a failed capture is reported truthfully and the order stays awaiting', async () => {
    const id = await newOrder('s1', [{ productId: 'np-jacket', qty: 1 }]);
    d.pp.approve(id, HONEST);
    d.pp.captureOrder = async () => { throw new Error('PayPal down'); };
    const r = await approved(id, { sessionId: 's1' });
    expect(r.status).toBe(502);
    expect(r.body.message).toMatch(/not been charged/);
    expect(orderRow(id).status).toBe('AWAITING_APPROVAL');
  });
});

describe('GET /api/orders/:orderId/status', () => {
  it('returns only the public fields', async () => {
    const id = (await checkout({ sessionId: 's1', items: [{ productId: 'np-jacket', qty: 1 }], code: 'NP-STAFF-00A7-K9MD' })).body.orderId;
    const r = await request(app).get(`/api/orders/${id}/status`);
    expect(r.body).toEqual({ orderId: id, status: 'AWAITING_APPROVAL', message: MESSAGES.AWAITING_APPROVAL });
    expect((await request(app).get('/api/orders/NOPE/status')).status).toBe(404);
  });
});

describe('POST /api/dashboard/review/:orderId', () => {
  async function heldOrder() {
    const id = (await checkout({ sessionId: 's1', items: [{ productId: 'np-jacket', qty: 1 }], code: 'NP-STAFF-00A7-K9MD' })).body.orderId;
    d.pp.approve(id, DEV);
    await approved(id, { sessionId: 's1' });
    d.events.length = 0;
    return id as string;
  }
  const review = (id: string, body: object) => request(app).post(`/api/dashboard/review/${id}`).send(body);

  it('release captures a held order after a human decision', async () => {
    const id = await heldOrder();
    const r = await review(id, { decision: 'release', note: 'false alarm' });
    expect(r.body).toEqual({ orderId: id, status: 'COMPLETED', message: MESSAGES.COMPLETED });
    expect(d.pp.captures).toHaveLength(1);
    expect(orderRow(id)).toMatchObject({ trapped: 0, status: 'COMPLETED' });
    expect(d.events.find((e) => e.kind === 'REVIEW_DECISION')!.detail).toMatchObject({ decision: 'release', note: 'false alarm', orderId: id, captured: true });
  });

  it('cancel marks it CANCELLED and moves no money', async () => {
    const id = await heldOrder();
    const r = await review(id, { decision: 'cancel' });
    expect(r.body).toEqual({ orderId: id, status: 'CANCELLED', message: MESSAGES.CANCELLED });
    expect(d.pp.captures).toHaveLength(0);
    expect(kinds(d)).toEqual(['REVIEW_DECISION']);
  });

  it('a failed release capture keeps the order held and trapped', async () => {
    const id = await heldOrder();
    d.pp.captureOrder = async () => { throw new Error('approval expired'); };
    const r = await review(id, { decision: 'release' });
    expect(r.status).toBe(409);
    expect(r.body.status).toBe('PENDING_REVIEW');
    expect(orderRow(id)).toMatchObject({ trapped: 1, status: 'PENDING_REVIEW' });
  });

  it('rejects bad decisions, unknown orders and orders not under review', async () => {
    const id = await heldOrder();
    expect((await review(id, { decision: 'refund' })).status).toBe(400);
    expect((await review('NOPE', { decision: 'cancel' })).status).toBe(404);
    await review(id, { decision: 'cancel' });
    expect((await review(id, { decision: 'release' })).status).toBe(409);
  });
});

describe('browser never receives trap internals', () => {
  it('no store-facing response mentions trapped, decoy registry, source session or real floors', async () => {
    const bodies: string[] = [];
    const c = await checkout({ sessionId: 'dw1', items: [{ productId: 'dw-grinder', qty: 1 }], code: 'NP-MGR-00A1-Q2XF' });
    bodies.push(JSON.stringify(c.body));
    d.pp.approve(c.body.orderId, DEV);
    bodies.push(JSON.stringify((await approved(c.body.orderId, { sessionId: 'dw1' })).body));
    bodies.push(JSON.stringify((await request(app).get(`/api/orders/${c.body.orderId}/status`)).body));
    for (const b of bodies) {
      expect(b).not.toMatch(/trap|decoy|source|s0|refund_override|NETWORK|IDENTITY/i);
      for (const s of Object.values(SECRETS)) expect(b).not.toContain(String(s.realFloorCents));
    }
  });
});

describe('GET /api/dashboard/payers/:payerId/history', () => {
  it('returns PayPal history for the payer via the Agent Toolkit', async () => {
    d.toolkitTools.list_transactions = {
      execute: async () => JSON.stringify({ transaction_details: [{ transaction_info: { transaction_id: 'T1', transaction_amount: { currency_code: 'USD', value: '57.00' } }, payer_info: { account_id: 'DEVPAYER01' } }] }),
    };
    const r = await request(app).get('/api/dashboard/payers/DEVPAYER01/history');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ payerId: 'DEVPAYER01', transactions: [{ transactionId: 'T1', amountCents: 5700 }] });
  });

  it('reports an error instead of failing when the toolkit is unavailable', async () => {
    d.toolkit = () => { throw new Error('Missing PAYPAL_CLIENT_ID'); };
    const r = await request(app).get('/api/dashboard/payers/DEVPAYER01/history');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ payerId: 'DEVPAYER01', transactions: [], error: expect.stringMatching(/PAYPAL_CLIENT_ID/) });
  });
});

describe('fake floor quotes (A accepts an offer equal to a planted fake floor)', () => {
  const quote = (sessionId: string, productId: string, cents: number) =>
    d.db.prepare('INSERT INTO quotes VALUES (?, ?, ?, ?)').run(sessionId, productId, cents, 'now');

  it('traps the order at the agreed fake price and attributes it', async () => {
    quote('s1', 'np-jacket', 6137);
    d.floors.set('s1|np-jacket', { sourceSessionId: 's1' });
    const r = await checkout({ sessionId: 's1', items: [{ productId: 'np-jacket', qty: 1 }] });
    expect(r.status).toBe(200);
    expect(r.body.totalCents).toBe(6137);
    expect(r.body.discountLabel).toBeUndefined();
    expect(orderRow(r.body.orderId)).toMatchObject({ trapped: 1, trap_source_session: 's1', code_used: 'floor:np-jacket:6137:s1' });
    const ev = d.events.find((e) => e.kind === 'DECOY_REDEEMED')!;
    expect(ev.severity).toBe('critical');
    expect(ev.detail).toMatchObject({ decoyKind: 'fake_floor', decoyCode: 'floor:np-jacket:6137:s1', productId: 'np-jacket', fakeFloorCents: 6137, sourceSessionId: 's1', attributedToSelf: true, orderId: r.body.orderId });
    await vi.waitFor(() => expect(kinds(d)).toContain('RISK_SIGNAL_SENT'));
  });

  it('a fake floor planted in another session is a spread edge', async () => {
    quote('s1', 'np-tent', 14321);
    d.floors.set('s1|np-tent', { sourceSessionId: 's0' });
    await checkout({ sessionId: 's1', items: [{ productId: 'np-tent', qty: 1 }] });
    expect(d.events.find((e) => e.kind === 'DECOY_REDEEMED')!.detail).toMatchObject({ sourceSessionId: 's0', attributedToSelf: false });
  });

  it('the trapped fake-floor order is held on approval, never captured, payer blocklisted', async () => {
    quote('s1', 'np-jacket', 6137);
    d.floors.set('s1|np-jacket', { sourceSessionId: 's1' });
    const id = (await checkout({ sessionId: 's1', items: [{ productId: 'np-jacket', qty: 1 }] })).body.orderId;
    d.pp.approve(id, DEV);
    const r = await approved(id, { sessionId: 's1' });
    expect(r.body).toEqual({ orderId: id, status: 'PENDING_REVIEW', message: PENDING });
    expect(d.pp.captures).toHaveLength(0);
    expect((d.db.prepare("SELECT reason FROM blocklist WHERE payer_id = 'DEVPAYER01'").get() as any).reason).toBe('decoy:fake_floor');
    await vi.waitFor(() => expect(d.events.filter((e) => e.kind === 'RISK_SIGNAL_SENT').map((e) => e.detail.trapKind)).toContain('fake_floor'));
  });

  it('a decoy code plus a fake floor reports both redemptions; the code is recorded', async () => {
    quote('s1', 'np-jacket', 6137);
    d.floors.set('s1|np-jacket', { sourceSessionId: 's1' });
    const r = await checkout({ sessionId: 's1', items: [{ productId: 'np-jacket', qty: 1 }], code: 'NP-STAFF-00A7-K9MD' });
    expect(orderRow(r.body.orderId).code_used).toBe('NP-STAFF-00A7-K9MD');
    expect(d.events.filter((e) => e.kind === 'DECOY_REDEEMED').map((e) => e.detail.decoyKind).sort()).toEqual(['fake_floor', 'staff_code']);
  });

  it('baseline honours an agreed quote below the real floor (that store is meant to lose money)', async () => {
    quote('base1', 'np-jacket', 5700);
    const r = await checkout({ sessionId: 'base1', items: [{ productId: 'np-jacket', qty: 1 }] });
    expect(r.body.totalCents).toBe(5700);
    expect(orderRow(r.body.orderId).trapped).toBe(0);
    expect(d.events).toHaveLength(0);
  });
});

describe('merge-review fixes', () => {
  it('DECOY_REDEEMED carries stage: checkout', async () => {
    await checkout({ sessionId: 's1', items: [{ productId: 'np-jacket', qty: 1 }], code: 'NP-STAFF-00A7-K9MD' });
    expect(d.events.find((e) => e.kind === 'DECOY_REDEEMED')!.detail.stage).toBe('checkout');
  });

  it('a PayPal outage at createOrder never loses the redemption event', async () => {
    d.pp.createOrder = async () => { throw new Error('PayPal down'); };
    const r = await checkout({ sessionId: 's1', items: [{ productId: 'np-jacket', qty: 1 }], code: 'NP-STAFF-00A7-K9MD' });
    expect(r.status).toBeGreaterThanOrEqual(500);
    const ev = d.events.find((e) => e.kind === 'DECOY_REDEEMED')!;
    expect(ev.detail).toMatchObject({ decoyCode: 'NP-STAFF-00A7-K9MD', stage: 'checkout', orderError: 'PayPal down' });
    expect(ev.detail.orderId).toBeUndefined();
  });

  it('rejects simulatedPayer with bad field types (400)', async () => {
    const id = (await checkout({ sessionId: 's1', items: [{ productId: 'np-jacket', qty: 1 }] })).body.orderId;
    expect((await approved(id, { sessionId: 's1', simulatedPayer: 'dev' })).status).toBe(400);
    expect((await approved(id, { sessionId: 's1', simulatedPayer: { payerId: 42 } })).status).toBe(400);
    expect((await approved(id, { sessionId: 's1', simulatedPayer: { payerId: 'P1', name: { first: 'x' } } })).status).toBe(400);
    expect((await approved(id, { sessionId: 's1', simulatedPayer: { payerId: 'P1', email: 'a@example.com' } })).status).toBe(200);
  });

  it('baseline: the real staff code does not stack on an agreed quote (better of the two)', async () => {
    d.db.prepare("INSERT INTO quotes VALUES ('base1', 'np-jacket', 8000, 'now'), ('base1', 'np-boots', 6000, 'now')").run();
    const r = await checkout({ sessionId: 'base1', items: [{ productId: 'np-jacket', qty: 1 }, { productId: 'np-boots', qty: 1 }], code: 'NP-CREW-2291' });
    // jacket: staff 5700 beats quote 8000; boots: quote 6000 beats staff 8400
    expect(r.body.totalCents).toBe(5700 + 6000);
    expect(r.body.discountLabel).toBe('Staff pricing (40% off)');
  });

  it('baseline: no staff label when every agreed quote already beats the staff price', async () => {
    d.db.prepare("INSERT INTO quotes VALUES ('base1', 'np-jacket', 5000, 'now')").run();
    const r = await checkout({ sessionId: 'base1', items: [{ productId: 'np-jacket', qty: 1 }], code: 'NP-CREW-2291' });
    expect(r.body.totalCents).toBe(5000);
    expect(r.body.discountLabel).toBeUndefined();
  });

  describe('review release is merchant-only', () => {
    async function held() {
      const id = (await checkout({ sessionId: 's1', items: [{ productId: 'np-jacket', qty: 1 }], code: 'NP-STAFF-00A7-K9MD' })).body.orderId as string;
      d.pp.approve(id, DEV);
      await approved(id, { sessionId: 's1' });
      return id;
    }
    const review = (id: string, body: object, headers: Record<string, string> = {}) => {
      let r = request(app).post(`/api/dashboard/review/${id}`);
      for (const [k, v] of Object.entries(headers)) r = r.set(k, v);
      return r.send(body);
    };

    it('refuses release from a proxied (non-loopback) client without the admin token', async () => {
      const id = await held();
      const r = await review(id, { decision: 'release' }, { 'X-Forwarded-For': '203.0.113.9' });
      expect(r.status).toBe(403);
      expect(d.pp.captures).toHaveLength(0);
    });

    it('allows release with the right admin token, refuses a wrong one', async () => {
      d.config.adminToken = 'tok-123';
      const id = await held();
      expect((await review(id, { decision: 'release' }, { 'X-Forwarded-For': '203.0.113.9', 'x-mirage-admin': 'nope' })).status).toBe(403);
      expect((await review(id, { decision: 'release' }, { 'X-Forwarded-For': '203.0.113.9', 'x-mirage-admin': 'tok-123' })).status).toBe(200);
      expect(d.pp.captures).toHaveLength(1);
    });

    it('cancel stays open', async () => {
      const id = await held();
      expect((await review(id, { decision: 'cancel' }, { 'X-Forwarded-For': '203.0.113.9' })).status).toBe(200);
    });
  });
});
