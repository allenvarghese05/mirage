import { describe, expect, it } from 'vitest';
import { addSession, memoryDb } from '../paypal/test-helpers';
import { blockPayer, clientFingerprint, findFingerprintMatch, getBlocked, listBlocked, recordHit } from './blocklist';

describe('payer blocklist', () => {
  it('blocks a payer once, keeping the first store and session', () => {
    const db = memoryDb();
    expect(blockPayer(db, { payerId: 'P1', storeId: 'northpeak', sessionId: 's1', reason: 'decoy:staff_code' })).toEqual({ created: true });
    expect(blockPayer(db, { payerId: 'P1', storeId: 'driftwood', sessionId: 's2', reason: 'network' })).toEqual({ created: false });
    expect(getBlocked(db, 'P1')).toMatchObject({ payerId: 'P1', firstSeenStore: 'northpeak', firstSessionId: 's1', reason: 'decoy:staff_code', hits: 0 });
  });

  it('returns null for an unknown payer', () => {
    expect(getBlocked(memoryDb(), 'NOPE')).toBeNull();
  });

  it('counts hits', () => {
    const db = memoryDb();
    blockPayer(db, { payerId: 'P1', storeId: 'northpeak', sessionId: 's1', reason: 'x' });
    recordHit(db, 'P1');
    recordHit(db, 'P1');
    expect(getBlocked(db, 'P1')!.hits).toBe(2);
  });

  it('lists blocked payers in the NetworkRes shape, newest first', () => {
    const db = memoryDb();
    blockPayer(db, { payerId: 'P1', storeId: 'northpeak', sessionId: 's1', reason: 'a', at: '2026-11-10T00:00:00.000Z' });
    blockPayer(db, { payerId: 'P2', storeId: 'driftwood', sessionId: 's2', reason: 'b', at: '2026-11-11T00:00:00.000Z' });
    expect(listBlocked(db).map((b) => b.payerId)).toEqual(['P2', 'P1']);
    expect(Object.keys(listBlocked(db)[0]).sort()).toEqual(['at', 'firstSeenStore', 'firstSessionId', 'hits', 'payerId', 'reason']);
  });
});

describe('client fingerprint', () => {
  it('is stable for the same ip and user agent, and differs otherwise', () => {
    expect(clientFingerprint('8.8.8.8', 'UA')).toBe(clientFingerprint('8.8.8.8', 'UA'));
    expect(clientFingerprint('8.8.8.8', 'UA')).not.toBe(clientFingerprint('8.8.4.4', 'UA'));
    expect(clientFingerprint('8.8.8.8', 'UA')).toMatch(/^[0-9a-f]{16}$/);
  });

  it('matches a new session to a session whose payer was blocklisted', () => {
    const db = memoryDb();
    addSession(db, { id: 'bad', ip: '203.0.113.9', userAgent: 'Firefox' });
    blockPayer(db, { payerId: 'P1', storeId: 'northpeak', sessionId: 'bad', reason: 'decoy' });
    addSession(db, { id: 'new', storeId: 'driftwood', ip: '203.0.113.9', userAgent: 'Firefox' });
    expect(findFingerprintMatch(db, 'new')).toEqual({ matchedSessionId: 'bad', fingerprint: clientFingerprint('203.0.113.9', 'Firefox') });
  });

  it('matches through an order whose payer is blocklisted', () => {
    const db = memoryDb();
    addSession(db, { id: 'bad2', ip: '203.0.113.9', userAgent: 'Firefox' });
    db.prepare(`INSERT INTO orders (order_id, session_id, store_id, total_cents, status, payer_id, created_at) VALUES ('O', 'bad2', 'northpeak', 100, 'PENDING_REVIEW', 'P9', 'now')`).run();
    blockPayer(db, { payerId: 'P9', storeId: 'driftwood', sessionId: 'elsewhere', reason: 'x' });
    addSession(db, { id: 'new', ip: '203.0.113.9', userAgent: 'Firefox' });
    expect(findFingerprintMatch(db, 'new')?.matchedSessionId).toBe('bad2');
  });

  it('does not match a different client, a clean session, or itself', () => {
    const db = memoryDb();
    addSession(db, { id: 'bad', ip: '203.0.113.9', userAgent: 'Firefox' });
    blockPayer(db, { payerId: 'P1', storeId: 'northpeak', sessionId: 'bad', reason: 'decoy' });
    addSession(db, { id: 'other-ua', ip: '203.0.113.9', userAgent: 'Chrome' });
    addSession(db, { id: 'clean', ip: '198.51.100.1', userAgent: 'Firefox' });
    addSession(db, { id: 'clean2', ip: '198.51.100.1', userAgent: 'Firefox' });
    expect(findFingerprintMatch(db, 'other-ua')).toBeNull();
    expect(findFingerprintMatch(db, 'clean2')).toBeNull();
    expect(findFingerprintMatch(db, 'bad')).toBeNull();
  });

  it('never matches sim sessions or loopback/private/missing ips (they all share one client)', () => {
    const db = memoryDb();
    for (const [id, ip] of [['b1', '127.0.0.1'], ['b2', '::1'], ['b3', '10.0.0.5'], ['b4', '192.168.1.2'], ['b5', null], ['b6', '::ffff:127.0.0.1']] as const) {
      addSession(db, { id, ip, userAgent: 'UA' });
      blockPayer(db, { payerId: `P-${id}`, storeId: 'northpeak', sessionId: id, reason: 'x' });
      addSession(db, { id: `${id}-new`, ip, userAgent: 'UA' });
      expect(findFingerprintMatch(db, `${id}-new`)).toBeNull();
    }
    addSession(db, { id: 'pub', ip: '203.0.113.50', userAgent: 'UA' });
    blockPayer(db, { payerId: 'P-pub', storeId: 'northpeak', sessionId: 'pub', reason: 'x' });
    addSession(db, { id: 'sim-new', ip: '203.0.113.50', userAgent: 'UA', simRunId: 'run1' });
    expect(findFingerprintMatch(db, 'sim-new')).toBeNull();
  });
});
