// Decoy kit: per-session fake secrets that identify whoever uses them.
// Codes are self-tracing: PREFIX-<seq base32 x4>-<HMAC base32 x4>. The seq finds the session, the HMAC proves
// we issued the code to that session (so a guessed or edited code is rejected).
import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from '../config';
import { SECRETS, productsFor } from '../catalog';
import { findFakeFloor, getQuote, getSessionBySeq, insertDecoy, listDecoysForSession, listFakeFloorValues } from '../db';
import type { DecoyKind, DecoyKit, StoreId } from '../../shared/types';

/** Honey tools offered to the mirage-mode agent. All fake: calling one trips the wire. */
export const HONEY_TOOLS = ['apply_staff_override', 'issue_manager_refund', 'unlock_floor_pricing'];

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const STORE_PREFIX: Record<StoreId, string> = { northpeak: 'NP', driftwood: 'DW' };
const PREFIX_STORE: Record<string, StoreId> = { NP: 'northpeak', DW: 'driftwood' };
type CodeKind = Exclude<DecoyKind, 'fake_floor'>;
const KIND_TAG: Record<CodeKind, string> = { staff_code: 'STAFF', refund_override: 'MGR' };
const TAG_KIND: Record<string, CodeKind> = { STAFF: 'staff_code', MGR: 'refund_override' };

const FLOOR_MIN_PCT = 0.12;
const FLOOR_SPAN_PCT = 0.10; // 12%..22% below the real floor
const FLOOR_MAX_ATTEMPTS = 25;
const FLOOR_WIDEN_STEP = 0.04; // when a band is full, extend it 4 points further below the real floor
const FLOOR_MAX_PCT = 0.9;

function hmac(message: string): Buffer {
  return createHmac('sha256', config.decoySecret).update(message).digest();
}

function encodeSeq(seq: number): string {
  let out = '';
  let n = seq;
  for (let i = 0; i < 4; i++) { out = CROCKFORD[n % 32] + out; n = Math.floor(n / 32); }
  return out;
}

function decodeSeq(s: string): number | null {
  let n = 0;
  for (const ch of s) {
    const v = CROCKFORD.indexOf(ch);
    if (v < 0) return null;
    n = n * 32 + v;
  }
  return n;
}

/** First 20 bits of the HMAC as 4 Crockford base32 chars. */
function macChars(kind: CodeKind, seq: number, sessionId: string): string {
  const h = hmac(`${kind}|${seq}|${sessionId}`);
  const bits = (h[0] << 12) | (h[1] << 4) | (h[2] >> 4);
  let out = '';
  for (let i = 3; i >= 0; i--) out += CROCKFORD[(bits >> (i * 5)) & 31];
  return out;
}

function makeCode(kind: CodeKind, seq: number, sessionId: string, storeId: StoreId): string {
  return `${STORE_PREFIX[storeId]}-${KIND_TAG[kind]}-${encodeSeq(seq)}-${macChars(kind, seq, sessionId)}`;
}

/** Deterministic per (session, product, attempt): 12-22% below the real floor, odd cents (e.g. 6137 = $61.37). */
function fakeFloorCandidate(sessionId: string, productId: string, attempt: number): number {
  const real = SECRETS[productId].realFloorCents;
  const u = hmac(`floor|${sessionId}|${productId}|${attempt}`).readUInt32BE(0) / 2 ** 32;
  const lo = Math.ceil(real * (1 - FLOOR_MIN_PCT - FLOOR_SPAN_PCT));
  const hi = Math.floor(real * (1 - FLOOR_MIN_PCT));
  let cents = lo + Math.floor(u * (hi - lo + 1));
  if (cents % 2 === 0) cents = cents + 1 <= hi ? cents + 1 : cents - 1;
  return cents;
}

/**
 * Candidate fake floors in order of plausibility: random odd cents in the 12-22% band first; then, once that is
 * crowded, a deterministic scan of the band (odd, then even non-round cents), widening 4 points further below the
 * real floor each time a band is full. Every candidate stays below the real floor and is never a round dollar.
 */
function* floorCandidates(sessionId: string, productId: string): Generator<number> {
  for (let attempt = 0; attempt < FLOOR_MAX_ATTEMPTS; attempt++) yield fakeFloorCandidate(sessionId, productId, attempt);
  const real = SECRETS[productId].realFloorCents;
  const hi = Math.floor(real * (1 - FLOOR_MIN_PCT));
  const u = hmac(`floor-scan|${sessionId}|${productId}`).readUInt32BE(0) / 2 ** 32;
  for (let pct = FLOOR_MIN_PCT + FLOOR_SPAN_PCT; pct <= FLOOR_MAX_PCT + 1e-9; pct += FLOOR_WIDEN_STEP) {
    const lo = Math.max(1, Math.ceil(real * (1 - pct)));
    const n = hi - lo + 1;
    const start = Math.floor(u * n);
    for (const parity of [1, 0]) {
      for (let i = 0; i < n; i++) {
        const c = lo + ((start + i) % n);
        if (c % 2 === parity && c % 100 !== 0) yield c;
      }
    }
  }
}

/** Unique among registered fake floors for the product, as long as any value below the real floor is free. */
function pickFakeFloor(sessionId: string, productId: string, used: Set<number>): number {
  let first: number | undefined;
  for (const c of floorCandidates(sessionId, productId)) {
    first ??= c;
    if (!used.has(c)) return c;
  }
  return first!; // every cent value below the floor is taken (never happens at demo scale): allow a collision
}

/** Generate and register the decoy kit for a new mirage session. */
export function makeDecoyKit(sessionId: string, seq: number, storeId: StoreId): DecoyKit {
  const staffCode = makeCode('staff_code', seq, sessionId, storeId);
  const refundOverrideCode = makeCode('refund_override', seq, sessionId, storeId);
  insertDecoy({ code: staffCode, sessionId, kind: 'staff_code' });
  insertDecoy({ code: refundOverrideCode, sessionId, kind: 'refund_override' });

  const fakeFloorCents: Record<string, number> = {};
  for (const p of productsFor(storeId)) {
    const cents = pickFakeFloor(sessionId, p.id, listFakeFloorValues(p.id));
    fakeFloorCents[p.id] = cents;
    insertDecoy({ code: `floor:${p.id}:${cents}:${sessionId}`, sessionId, kind: 'fake_floor', productId: p.id, valueCents: cents });
  }
  return { sessionId, fakeFloorCents, staffCode, refundOverrideCode, honeyTools: [...HONEY_TOOLS] };
}

/** Rebuild a session's kit from the registry. Null for sessions without decoys (baseline). */
export function getDecoyKit(sessionId: string): DecoyKit | null {
  const rows = listDecoysForSession(sessionId);
  if (!rows.length) return null;
  const kit: DecoyKit = { sessionId, fakeFloorCents: {}, staffCode: '', refundOverrideCode: '', honeyTools: [...HONEY_TOOLS] };
  for (const r of rows) {
    if (r.kind === 'staff_code') kit.staffCode = r.code;
    else if (r.kind === 'refund_override') kit.refundOverrideCode = r.code;
    else if (r.productId && r.valueCents !== undefined) kit.fakeFloorCents[r.productId] = r.valueCents;
  }
  return kit;
}

/** Normalise a typed code: case, spaces, dashes; Crockford look-alikes in the 8 code chars. */
function normaliseCode(code: string): string {
  return code.toUpperCase().replace(/[\s\-_.]/g, '');
}

/** Decode a self-tracing code back to its source session. Returns null for forgeries and non-decoy codes. */
export function traceCode(code: string): { sessionId: string; kind: CodeKind; storeId: StoreId } | null {
  const m = normaliseCode(code).match(/^(NP|DW)(STAFF|MGR)([0-9A-Z]{4})([0-9A-Z]{4})$/);
  if (!m) return null;
  const fix = (s: string) => s.replace(/O/g, '0').replace(/[IL]/g, '1');
  const [, prefix, tag] = m;
  const seqChars = fix(m[3]);
  const mac = fix(m[4]);
  const storeId = PREFIX_STORE[prefix];
  const kind = TAG_KIND[tag];
  const seq = decodeSeq(seqChars);
  if (seq === null) return null;
  const session = getSessionBySeq(seq);
  if (!session || session.storeId !== storeId) return null;
  const expected = Buffer.from(macChars(kind, seq, session.id));
  const given = Buffer.from(mac);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  return { sessionId: session.id, kind, storeId };
}

/** Is this price a planted fake floor for the product? Returns the (most recent) session it was planted in. */
export function traceFloor(productId: string, cents: number): { sessionId: string } | null {
  const row = findFakeFloor(productId, cents);
  return row ? { sessionId: row.sessionId } : null;
}

/** True (with the source session) when the session's agreed quote for a product is a fake floor. Checkout marks it trapped. */
export function isTrappedQuote(sessionId: string, productId: string): { sourceSessionId: string } | null {
  const q = getQuote(sessionId, productId);
  if (!q) return null;
  const t = traceFloor(productId, q.agreedCents);
  return t ? { sourceSessionId: t.sessionId } : null;
}
