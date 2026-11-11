// Shared payer blocklist across Mirage stores, plus a client-fingerprint match (ip + user agent).
// Works on the contract tables `blocklist`, `sessions` and `orders` (server/db/schema.sql).
import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { NetworkRes } from '../../shared/api';
import type { StoreId } from '../../shared/types';

export type BlockedPayer = NetworkRes['blocked'][number];

const toBlocked = (r: any): BlockedPayer => ({
  payerId: r.payer_id, firstSeenStore: r.first_seen_store, firstSessionId: r.first_session_id,
  reason: r.reason, at: r.at, hits: Number(r.hits),
});

export function getBlocked(db: DatabaseSync, payerId: string): BlockedPayer | null {
  const r = db.prepare('SELECT * FROM blocklist WHERE payer_id = ?').get(payerId);
  return r ? toBlocked(r) : null;
}

/** Adds the payer if new. An existing entry keeps its first store/session/reason. */
export function blockPayer(db: DatabaseSync, o: { payerId: string; storeId: StoreId; sessionId: string; reason: string; at?: string }): { created: boolean } {
  const r = db.prepare(
    'INSERT INTO blocklist (payer_id, first_seen_store, first_session_id, reason, hits, at) VALUES (?, ?, ?, ?, 0, ?) ON CONFLICT(payer_id) DO NOTHING',
  ).run(o.payerId, o.storeId, o.sessionId, o.reason, o.at ?? new Date().toISOString());
  return { created: Number(r.changes) > 0 };
}

export function recordHit(db: DatabaseSync, payerId: string): void {
  db.prepare('UPDATE blocklist SET hits = hits + 1 WHERE payer_id = ?').run(payerId);
}

/** For GET /api/dashboard/network (Workstream A's route can return this directly). */
export function listBlocked(db: DatabaseSync): BlockedPayer[] {
  return db.prepare('SELECT * FROM blocklist ORDER BY at DESC').all().map(toBlocked);
}

export function clientFingerprint(ip: string, userAgent: string): string {
  return createHash('sha256').update(`${ip}|${userAgent}`).digest('hex').slice(0, 16);
}

/**
 * Loopback, private and missing IPs are shared by many clients (the sim runner, a local demo,
 * a proxy without trust-proxy), so they must never be used to link people.
 */
export function isLinkableIp(ip: string | null | undefined): ip is string {
  if (!ip) return false;
  const v = ip.toLowerCase().replace(/^::ffff:/, '');
  if (v === '::1' || v === 'localhost' || v === 'unknown') return false;
  if (/^(127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(v)) return false;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(v)) return false;
  if (/^(fc|fd|fe80)/.test(v)) return false;
  return true;
}

/**
 * Finds an earlier session from the same client (same public ip + user agent) that is linked to a
 * blocklisted payer: it was the payer's first session, or it has an order paid by a blocked payer.
 * Never matches sim sessions (one runner = one client) or non-linkable IPs.
 */
export function findFingerprintMatch(
  db: DatabaseSync, sessionId: string, fallback?: { ip?: string | null; userAgent?: string | null },
): { matchedSessionId: string; fingerprint: string } | null {
  const row = db.prepare('SELECT ip, user_agent, sim_run_id FROM sessions WHERE id = ?').get(sessionId) as
    | { ip: string | null; user_agent: string | null; sim_run_id: string | null } | undefined;
  if (!row || row.sim_run_id) return null;
  // Prefer what the session recorded at creation; fall back to the current request.
  const s = { ip: row.ip ?? fallback?.ip ?? null, user_agent: row.user_agent ?? fallback?.userAgent ?? null };
  if (!isLinkableIp(s.ip) || !s.user_agent) return null;
  const m = db.prepare(`
    SELECT s.id FROM sessions s
    WHERE s.id != ? AND s.ip = ? AND s.user_agent = ? AND s.sim_run_id IS NULL AND (
      s.id IN (SELECT first_session_id FROM blocklist)
      OR s.id IN (SELECT o.session_id FROM orders o JOIN blocklist b ON b.payer_id = o.payer_id)
    )
    ORDER BY s.created_at ASC LIMIT 1`).get(sessionId, s.ip, s.user_agent) as { id: string } | undefined;
  return m ? { matchedSessionId: m.id, fingerprint: clientFingerprint(s.ip, s.user_agent) } : null;
}
