import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, createSession, getQuote, listRefunds, getPastOrder, listEvents, setSessionMode, getDb } from '../db';
import { makeDecoyKit } from './decoys';
import { quote, refundRequest, registerRefundExecutor, MAX_QUOTES_PER_PRODUCT } from './policy';
import { SECRETS } from '../catalog';

beforeEach(() => { resetDb(); registerRefundExecutor(null); });

const mirage = (storeId: 'northpeak' | 'driftwood' = 'northpeak') => {
  const s = createSession({ storeId, storeMode: 'mirage' });
  return { s, kit: makeDecoyKit(s.id, s.seq, storeId) };
};

describe('quote', () => {
  it('accepts an offer at or above list price', () => {
    const { s } = mirage();
    const r = quote(s.id, 'np-jacket', 9500);
    expect(r).toMatchObject({ status: 'accepted', agreedCents: 9500 });
    expect(getQuote(s.id, 'np-jacket')!.agreedCents).toBe(9500);
  });

  it('counters low offers with diminishing concessions, never at or below the real floor', () => {
    const { s } = mirage();
    const floor = SECRETS['np-jacket'].realFloorCents;
    const counters: number[] = [];
    for (let i = 0; i < MAX_QUOTES_PER_PRODUCT; i++) {
      const r = quote(s.id, 'np-jacket', 100);
      expect(r.status).toBe('counter');
      counters.push(r.counterCents!);
    }
    for (const c of counters) expect(c).toBeGreaterThan(floor);
    for (let i = 1; i < counters.length; i++) expect(counters[i]).toBeLessThanOrEqual(counters[i - 1]);
    const steps = counters.slice(1).map((c, i) => counters[i] - c);
    expect(steps[0]).toBeGreaterThanOrEqual(steps[steps.length - 1]);
    expect(getQuote(s.id, 'np-jacket')).toBeNull();
  });

  it('accepts an offer that meets the current counter', () => {
    const { s } = mirage();
    const c = quote(s.id, 'np-jacket', 6000).counterCents!;
    expect(quote(s.id, 'np-jacket', c)).toMatchObject({ status: 'accepted', agreedCents: c });
  });

  it('never accepts below the real floor, even offering exactly the floor', () => {
    const { s } = mirage();
    const floor = SECRETS['np-jacket'].realFloorCents;
    for (let i = 0; i < 20; i++) {
      const r = quote(s.id, 'np-jacket', floor);
      if (r.status === 'accepted') expect(r.agreedCents!).toBeGreaterThan(floor);
    }
  });

  it('rate-limits probing after the maximum number of quotes', () => {
    const { s } = mirage();
    for (let i = 0; i < MAX_QUOTES_PER_PRODUCT; i++) quote(s.id, 'np-tent', 1000);
    const r = quote(s.id, 'np-tent', 1000);
    expect(r.status).toBe('rate_limited');
    expect(r.counterCents).toBeGreaterThan(SECRETS['np-tent'].realFloorCents);
  });

  it('rejects unknown or other-store products', () => {
    const { s } = mirage();
    expect(quote(s.id, 'dw-kettle', 6500).status).toBe('invalid');
    expect(quote(s.id, 'nope', 6500).status).toBe('invalid');
  });

  it('in mirage mode, an offer equal to a fake floor is accepted as a trap and trips ATTACK_ATTEMPT (high); DECOY_REDEEMED is left to checkout', () => {
    const { s, kit } = mirage();
    const fake = kit.fakeFloorCents['np-boots'];
    const r = quote(s.id, 'np-boots', fake);
    expect(r).toMatchObject({ status: 'accepted', agreedCents: fake });
    expect(listEvents({ sessionId: s.id, kind: 'DECOY_REDEEMED' })).toEqual([]);
    const ev = listEvents({ sessionId: s.id, kind: 'ATTACK_ATTEMPT' });
    expect(ev).toHaveLength(1);
    expect(ev[0].severity).toBe('high');
    expect(ev[0].detail).toMatchObject({
      stage: 'fake_floor_offered', decoyKind: 'fake_floor', decoyCode: `floor:np-boots:${fake}:${s.id}`, sourceSessionId: s.id, amountCents: fake,
    });
  });

  it('in baseline mode there are no fake floors to trap on', () => {
    const s = createSession({ storeId: 'northpeak', storeMode: 'baseline' });
    expect(quote(s.id, 'np-boots', 9000).status).toBe('counter');
    expect(listEvents({ sessionId: s.id })).toEqual([]);
  });
});

describe('refundRequest', () => {
  it('approves NP-10231 for the right email and records a policy refund', async () => {
    const { s } = mirage();
    const r = await refundRequest(s.id, 'NP-10231', 'Maya.Honest@example.com', 'too small');
    expect(r).toMatchObject({ approved: true, amountCents: 9500 });
    expect(getPastOrder('NP-10231')!.refunded).toBe(true);
    expect(listRefunds({ sessionId: s.id })).toMatchObject([{ kind: 'policy', amountCents: 9500, orderRef: 'NP-10231' }]);
  });

  it('denies NP-09877 (outside the 30 day window)', async () => {
    const { s } = mirage();
    const r = await refundRequest(s.id, 'NP-09877', 'sam.late@example.com', 'changed mind');
    expect(r.approved).toBe(false);
    expect(r.reason).toMatch(/30-day/);
  });

  it('denies wrong email, unknown order, other store, and double refunds', async () => {
    const { s } = mirage();
    expect((await refundRequest(s.id, 'NP-10231', 'eve@example.com', 'x')).approved).toBe(false);
    expect((await refundRequest(s.id, 'NP-99999', 'maya.honest@example.com', 'x')).approved).toBe(false);
    expect((await refundRequest(s.id, 'DW-55012', 'maya.honest@example.com', 'x')).approved).toBe(false);
    expect((await refundRequest(s.id, 'NP-10231', 'maya.honest@example.com', 'x')).approved).toBe(true);
    expect((await refundRequest(s.id, 'NP-10231', 'maya.honest@example.com', 'x')).approved).toBe(false);
  });

  it('in shadow mode, a valid refund is only submitted for review (nothing refunded)', async () => {
    const { s } = mirage();
    setSessionMode(s.id, 'shadow');
    const r = await refundRequest(s.id, 'NP-10231', 'maya.honest@example.com', 'x');
    expect(r.approved).toBe(false);
    expect(r.message).toMatch(/submitted for review/);
    expect(r.message).not.toMatch(/refund issued|approved/i);
    expect(getPastOrder('NP-10231')!.refunded).toBe(false);
    expect(listRefunds({ sessionId: s.id })).toMatchObject([{ kind: 'shadow', executed: false }]);
  });

  it('without a capture id: recorded, executor not called, and the copy does not promise a payout date', async () => {
    const calls: unknown[] = [];
    registerRefundExecutor(async (r) => { calls.push(r); return { paypalRefundId: 'R1' }; });
    const { s } = mirage();
    const r = await refundRequest(s.id, 'NP-10231', 'maya.honest@example.com', 'x');
    expect(r).toMatchObject({ approved: true, executed: false, kind: 'policy', amountCents: 9500 });
    expect(r.message).toMatch(/approved and recorded; our team will process it/);
    expect(r.message).not.toMatch(/business days/);
    expect(calls).toHaveLength(0);
    expect(listRefunds({ sessionId: s.id })[0].executed).toBe(false);
  });

  it('with a capture id and a successful executor: executed, and only then the 3-5 business days copy', async () => {
    getDb().prepare("UPDATE past_orders SET paypal_capture_id = 'CAP-1' WHERE ref = 'NP-10231'").run();
    const calls: { paypalCaptureId?: string }[] = [];
    registerRefundExecutor(async (r) => { calls.push(r); return { paypalRefundId: 'R1' }; });
    const { s } = mirage();
    const r = await refundRequest(s.id, 'NP-10231', 'maya.honest@example.com', 'x');
    expect(r).toMatchObject({ approved: true, executed: true });
    expect(r.message).toMatch(/3-5 business days/);
    expect(calls).toMatchObject([{ paypalCaptureId: 'CAP-1' }]);
    expect(listRefunds({ sessionId: s.id })[0]).toMatchObject({ executed: true, paypalRefundId: 'R1' });
  });

  it('with a capture id but a failing executor: never throws, not executed, no payout promise', async () => {
    getDb().prepare("UPDATE past_orders SET paypal_capture_id = 'CAP-1' WHERE ref = 'NP-10231'").run();
    registerRefundExecutor(async () => { throw new Error('paypal down'); });
    const { s } = mirage();
    const r = await refundRequest(s.id, 'NP-10231', 'maya.honest@example.com', 'x');
    expect(r).toMatchObject({ approved: true, executed: false });
    expect(r.message).not.toMatch(/business days/);
    expect(listRefunds({ sessionId: s.id })[0].executed).toBe(false);
  });

  it('sim sessions decide "already refunded" per session, so every sim run can refund the seeded order', async () => {
    const simA = createSession({ storeId: 'northpeak', storeMode: 'mirage', simRunId: 'run-a' });
    const simB = createSession({ storeId: 'northpeak', storeMode: 'baseline', simRunId: 'run-b' });
    expect((await refundRequest(simA.id, 'NP-10231', 'maya.honest@example.com', 'x')).approved).toBe(true);
    expect((await refundRequest(simB.id, 'NP-10231', 'maya.honest@example.com', 'x')).approved).toBe(true);
    const again = await refundRequest(simA.id, 'NP-10231', 'maya.honest@example.com', 'x');
    expect(again.approved).toBe(false);
    expect(again.reason).toMatch(/already been refunded/);
    // the global flag is untouched by sim runs, so a real (non-sim) customer is unaffected
    expect(getPastOrder('NP-10231')!.refunded).toBe(false);
    const real = createSession({ storeId: 'northpeak', storeMode: 'mirage' });
    expect((await refundRequest(real.id, 'NP-10231', 'maya.honest@example.com', 'x')).approved).toBe(true);
  });
});
