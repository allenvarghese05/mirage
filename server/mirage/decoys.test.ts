import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, createSession } from '../db';
import { makeDecoyKit, getDecoyKit, traceCode, traceFloor, isTrappedQuote, HONEY_TOOLS } from './decoys';
import { upsertQuote } from '../db';
import { SECRETS, STORES, productsFor } from '../catalog';
import type { StoreId } from '../../shared/types';

beforeEach(() => resetDb());

function newKit(storeId: StoreId = 'northpeak') {
  const s = createSession({ storeId, storeMode: 'mirage' });
  return { session: s, kit: makeDecoyKit(s.id, s.seq, storeId) };
}

describe('decoy kit', () => {
  it('produces store-native self-tracing codes', () => {
    const { kit, session } = newKit('northpeak');
    expect(kit.sessionId).toBe(session.id);
    expect(kit.staffCode).toMatch(/^NP-STAFF-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
    expect(kit.refundOverrideCode).toMatch(/^NP-MGR-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
    expect(kit.honeyTools).toEqual(HONEY_TOOLS);
    const dw = newKit('driftwood').kit;
    expect(dw.staffCode).toMatch(/^DW-STAFF-/);
    expect(Object.keys(dw.fakeFloorCents).sort()).toEqual(productsFor('driftwood').map((p) => p.id).sort());
  });

  it('never produces a real code', () => {
    const reals = Object.values(STORES).flatMap((s) => [s.realStaffCode, s.realRefundOverride]);
    for (let i = 0; i < 50; i++) {
      const { kit } = newKit(i % 2 ? 'northpeak' : 'driftwood');
      expect(reals).not.toContain(kit.staffCode);
      expect(reals).not.toContain(kit.refundOverrideCode);
    }
  });

  it('fake floors are 12-22% below the real floor, odd cents, and deterministic per session', () => {
    const { kit, session } = newKit('northpeak');
    for (const [productId, fake] of Object.entries(kit.fakeFloorCents)) {
      const real = SECRETS[productId].realFloorCents;
      expect(fake).toBeLessThan(real);
      expect(fake).toBeGreaterThanOrEqual(Math.floor(real * 0.78));
      expect(fake).toBeLessThanOrEqual(Math.ceil(real * 0.88));
      expect(fake % 2).toBe(1);
    }
    expect(getDecoyKit(session.id)).toEqual(kit);
  });

  it('codes are unique across 1,000 sessions', () => {
    const codes = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      const { kit } = newKit('northpeak');
      codes.add(kit.staffCode);
      codes.add(kit.refundOverrideCode);
    }
    expect(codes.size).toBe(2000);
  });

  it('fake floors are unique among active sessions while the price band has room (retry on collision)', () => {
    // A 12-22% band of odd cents holds ~880 values for the tent and ~560 for boots, so test 300 sessions.
    const floors = new Map<string, number[]>();
    for (let i = 0; i < 300; i++) {
      const { kit } = newKit('northpeak');
      for (const [p, c] of Object.entries(kit.fakeFloorCents)) floors.set(p, [...(floors.get(p) ?? []), c]);
    }
    for (const p of ['np-tent', 'np-boots', 'np-jacket']) expect(new Set(floors.get(p)).size).toBe(300);
  });

  it('stays unique for large batches on a narrow band (300 sessions on dw-beans, ~85 odd values in-band)', () => {
    const real = SECRETS['dw-beans'].realFloorCents;
    const seen: number[] = [];
    for (let i = 0; i < 300; i++) seen.push(newKit('driftwood').kit.fakeFloorCents['dw-beans']);
    expect(new Set(seen).size).toBe(300);
    for (const c of seen) {
      expect(c).toBeLessThan(real);
      expect(c).toBeGreaterThan(0);
      expect(c % 100).not.toBe(0); // never a round-dollar price
    }
    // every value traces back to exactly its own session
    const kits = seen.slice(-3);
    for (const c of kits) expect(traceFloor('dw-beans', c)).not.toBeNull();
    // the first sessions still get the plausible 12-22% band
    expect(seen[0]).toBeGreaterThanOrEqual(Math.floor(real * 0.78));
  });
});

describe('traceCode', () => {
  it('round-trips both code kinds to the source session', () => {
    const { kit, session } = newKit('driftwood');
    expect(traceCode(kit.staffCode)).toEqual({ sessionId: session.id, kind: 'staff_code', storeId: 'driftwood' });
    expect(traceCode(kit.refundOverrideCode)).toEqual({ sessionId: session.id, kind: 'refund_override', storeId: 'driftwood' });
  });

  it('accepts lowercase, spaced and undashed variants', () => {
    const { kit, session } = newKit();
    expect(traceCode(kit.staffCode.toLowerCase())?.sessionId).toBe(session.id);
    expect(traceCode(kit.staffCode.replace(/-/g, ' '))?.sessionId).toBe(session.id);
    expect(traceCode(kit.staffCode.replace(/-/g, ''))?.sessionId).toBe(session.id);
  });

  it('rejects forged, tampered and real codes', () => {
    const { kit } = newKit();
    newKit();
    const last = kit.staffCode.slice(-1) === 'A' ? 'B' : 'A';
    expect(traceCode(kit.staffCode.slice(0, -1) + last)).toBeNull();
    // swap the seq to another (existing) session, keep the HMAC -> rejected
    const otherSeq = kit.staffCode.replace(/^(NP-STAFF-)([0-9A-Z]{4})/, (_m, p, seq) => p + (seq === '0002' ? '0001' : '0002'));
    expect(traceCode(otherSeq)).toBeNull();
    // swap kind keeps HMAC of the wrong kind -> rejected
    expect(traceCode(kit.staffCode.replace('STAFF', 'MGR'))).toBeNull();
    // wrong store prefix -> rejected
    expect(traceCode(kit.staffCode.replace('NP-', 'DW-'))).toBeNull();
    expect(traceCode('NP-CREW-2291')).toBeNull();
    expect(traceCode('garbage')).toBeNull();
    expect(traceCode('NP-STAFF-ZZZZ-AAAA')).toBeNull();
  });
});

describe('fake floor tracing', () => {
  it('traces a fake floor price and flags a trapped quote', () => {
    const { kit, session } = newKit();
    const fake = kit.fakeFloorCents['np-jacket'];
    expect(traceFloor('np-jacket', fake)).toEqual({ sessionId: session.id });
    expect(traceFloor('np-jacket', fake + 2)).toBeNull();
    expect(isTrappedQuote(session.id, 'np-jacket')).toBeNull();
    upsertQuote(session.id, 'np-jacket', fake);
    expect(isTrappedQuote(session.id, 'np-jacket')).toEqual({ sourceSessionId: session.id });
    upsertQuote(session.id, 'np-boots', 13000);
    expect(isTrappedQuote(session.id, 'np-boots')).toBeNull();
  });
});
