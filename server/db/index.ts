// SQLite data layer (node:sqlite, no native deps). Owned by workstream A.
// Other workstreams use these helpers instead of writing SQL against tables they don't own.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomUUID } from 'node:crypto';
import { config } from '../config';
import { SEED_PAST_ORDERS } from '../catalog';
import type { AgentProfile } from '../agent/profile';
import type {
  ChatMessage, DecoyKind, PayerIdentity, PublicOrderStatus, SessionMode, SimRun, StoreId, StoreMode, TripEvent,
} from '../../shared/types';

const SCHEMA_PATH = fileURLToPath(new URL('./schema.sql', import.meta.url));

let db: DatabaseSync | null = null;

function dbPath(): string {
  return process.env.VITEST ? ':memory:' : config.dbPath;
}

function open(path: string): DatabaseSync {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const d = new DatabaseSync(path);
  d.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  d.exec(readFileSync(SCHEMA_PATH, 'utf8'));
  migrate(d);
  seedPastOrders(d);
  return d;
}

/** Additive columns for database files created before the column existed in schema.sql. */
export function migrate(d: DatabaseSync): void {
  const cols = new Set((d.prepare('PRAGMA table_info(sessions)').all() as { name: string }[]).map((c) => c.name));
  if (!cols.has('agent_profile')) d.exec('ALTER TABLE sessions ADD COLUMN agent_profile TEXT');
}

function seedPastOrders(d: DatabaseSync): void {
  const stmt = d.prepare(
    'INSERT OR IGNORE INTO past_orders (ref, store_id, customer_email, product_id, paid_cents, purchased_at) VALUES (?, ?, ?, ?, ?, ?)',
  );
  for (const o of SEED_PAST_ORDERS) {
    const purchasedAt = new Date(Date.now() - o.days_ago * 86_400_000).toISOString();
    stmt.run(o.ref, o.store_id, o.customer_email, o.product_id, o.paid_cents, purchasedAt);
  }
}

export function getDb(): DatabaseSync {
  if (!db) db = open(dbPath());
  return db;
}

/** Close and reopen. In tests this gives a fresh empty in-memory database. */
export function resetDb(): void {
  if (db) db.close();
  db = null;
  getDb();
}

const now = () => new Date().toISOString();
type Row = Record<string, unknown>;
const str = (v: unknown) => (v === null || v === undefined ? undefined : String(v));
const parseJson = <T>(v: unknown, fallback: T): T => {
  if (typeof v !== 'string') return fallback;
  try { return JSON.parse(v) as T; } catch { return fallback; }
};

// ---------------- sessions ----------------
export interface SessionRow {
  id: string; storeId: StoreId; storeMode: StoreMode; mode: SessionMode; seq: number;
  clientMetadataId: string; ip?: string; userAgent?: string; simRunId?: string; createdAt: string;
  /** Store-agent prompt profile at session start. Sessions from before profiles existed ran the hardened prompt. */
  agentProfile: AgentProfile;
}

const toSession = (r: Row): SessionRow => ({
  id: String(r.id), storeId: r.store_id as StoreId, storeMode: r.store_mode as StoreMode, mode: r.mode as SessionMode,
  seq: Number(r.seq), clientMetadataId: String(r.client_metadata_id), ip: str(r.ip), userAgent: str(r.user_agent),
  simRunId: str(r.sim_run_id), createdAt: String(r.created_at),
  agentProfile: r.agent_profile === 'realistic' ? 'realistic' : 'hardened',
});

export function createSession(input: { storeId: StoreId; storeMode: StoreMode; simRunId?: string; ip?: string; userAgent?: string; agentProfile?: AgentProfile }): SessionRow {
  const d = getDb();
  const id = `s_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
  const { next } = d.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM sessions').get() as { next: number };
  d.prepare(
    'INSERT INTO sessions (id, store_id, store_mode, mode, seq, client_metadata_id, ip, user_agent, sim_run_id, agent_profile, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(id, input.storeId, input.storeMode, 'normal', next, randomBytes(16).toString('hex'),
    input.ip ?? null, input.userAgent ?? null, input.simRunId ?? null, input.agentProfile ?? 'realistic', now());
  return getSession(id)!;
}

export function getSession(sessionId: string): SessionRow | null {
  const r = getDb().prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId) as Row | undefined;
  return r ? toSession(r) : null;
}

export function getSessionBySeq(seq: number): SessionRow | null {
  const r = getDb().prepare('SELECT * FROM sessions WHERE seq = ?').get(seq) as Row | undefined;
  return r ? toSession(r) : null;
}

export function setSessionMode(sessionId: string, mode: SessionMode): void {
  getDb().prepare('UPDATE sessions SET mode = ? WHERE id = ?').run(mode, sessionId);
}

export function listSessions(): SessionRow[] {
  return (getDb().prepare('SELECT * FROM sessions ORDER BY created_at DESC, seq DESC').all() as Row[]).map(toSession);
}

// ---------------- messages ----------------
export function addMessage(m: { sessionId: string; role: ChatMessage['role']; content: string; toolName?: string }): ChatMessage {
  const msg: ChatMessage = { id: `m_${randomUUID()}`, sessionId: m.sessionId, role: m.role, content: m.content, at: now() };
  if (m.toolName) msg.toolName = m.toolName;
  getDb().prepare('INSERT INTO messages (id, session_id, role, content, tool_name, at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(msg.id, msg.sessionId, msg.role, msg.content, m.toolName ?? null, msg.at);
  return msg;
}

export function listMessages(sessionId: string, opts: { includeTool?: boolean } = {}): ChatMessage[] {
  const includeTool = opts.includeTool ?? true;
  const rows = getDb().prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY rowid').all(sessionId) as Row[];
  return rows
    .filter((r) => includeTool || r.role !== 'tool')
    .map((r) => {
      const m: ChatMessage = { id: String(r.id), sessionId: String(r.session_id), role: r.role as ChatMessage['role'], content: String(r.content), at: String(r.at) };
      if (r.tool_name) m.toolName = String(r.tool_name);
      return m;
    });
}

export function countMessages(sessionId: string): number {
  return Number((getDb().prepare('SELECT COUNT(*) AS n FROM messages WHERE session_id = ?').get(sessionId) as { n: number }).n);
}

// ---------------- decoys ----------------
export interface DecoyRow { code: string; sessionId: string; kind: DecoyKind; productId?: string; valueCents?: number; createdAt: string }

const toDecoy = (r: Row): DecoyRow => ({
  code: String(r.code), sessionId: String(r.session_id), kind: r.kind as DecoyKind, productId: str(r.product_id),
  valueCents: r.value_cents === null || r.value_cents === undefined ? undefined : Number(r.value_cents), createdAt: String(r.created_at),
});

export function insertDecoy(d: { code: string; sessionId: string; kind: DecoyKind; productId?: string; valueCents?: number }): void {
  getDb().prepare('INSERT INTO decoys (code, session_id, kind, product_id, value_cents, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(d.code, d.sessionId, d.kind, d.productId ?? null, d.valueCents ?? null, now());
}

export function listDecoysForSession(sessionId: string): DecoyRow[] {
  return (getDb().prepare('SELECT * FROM decoys WHERE session_id = ? ORDER BY rowid').all(sessionId) as Row[]).map(toDecoy);
}

export function listFakeFloorValues(productId: string): Set<number> {
  const rows = getDb().prepare("SELECT value_cents FROM decoys WHERE kind = 'fake_floor' AND product_id = ?").all(productId) as Row[];
  return new Set(rows.map((r) => Number(r.value_cents)));
}

export function findFakeFloor(productId: string, valueCents: number): DecoyRow | null {
  const r = getDb().prepare("SELECT * FROM decoys WHERE kind = 'fake_floor' AND product_id = ? AND value_cents = ? ORDER BY rowid DESC LIMIT 1").get(productId, valueCents) as Row | undefined;
  return r ? toDecoy(r) : null;
}

// ---------------- events ----------------
export function insertEvent(e: TripEvent): void {
  getDb().prepare('INSERT INTO events (id, at, store_id, session_id, kind, severity, detail_json) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(e.id, e.at, e.storeId, e.sessionId, e.kind, e.severity, JSON.stringify(e.detail ?? {}));
}

const toEvent = (r: Row): TripEvent => ({
  id: String(r.id), at: String(r.at), storeId: r.store_id as StoreId, sessionId: String(r.session_id),
  kind: r.kind as TripEvent['kind'], severity: r.severity as TripEvent['severity'], detail: parseJson(r.detail_json, {}),
});

export function listEvents(opts: { since?: string; sessionId?: string; kind?: TripEvent['kind'] } = {}): TripEvent[] {
  const where: string[] = [];
  const args: string[] = [];
  if (opts.since) { where.push('at > ?'); args.push(opts.since); }
  if (opts.sessionId) { where.push('session_id = ?'); args.push(opts.sessionId); }
  if (opts.kind) { where.push('kind = ?'); args.push(opts.kind); }
  const sql = `SELECT * FROM events ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY at, rowid`;
  return (getDb().prepare(sql).all(...args) as Row[]).map(toEvent);
}

// ---------------- quotes ----------------
export function upsertQuote(sessionId: string, productId: string, agreedCents: number): void {
  getDb().prepare(
    'INSERT INTO quotes (session_id, product_id, agreed_cents, at) VALUES (?, ?, ?, ?) ON CONFLICT(session_id, product_id) DO UPDATE SET agreed_cents = excluded.agreed_cents, at = excluded.at',
  ).run(sessionId, productId, agreedCents, now());
}

export function getQuote(sessionId: string, productId: string): { agreedCents: number; at: string } | null {
  const r = getDb().prepare('SELECT * FROM quotes WHERE session_id = ? AND product_id = ?').get(sessionId, productId) as Row | undefined;
  return r ? { agreedCents: Number(r.agreed_cents), at: String(r.at) } : null;
}

export function listQuotes(sessionId: string): { productId: string; agreedCents: number; at: string }[] {
  return (getDb().prepare('SELECT * FROM quotes WHERE session_id = ?').all(sessionId) as Row[])
    .map((r) => ({ productId: String(r.product_id), agreedCents: Number(r.agreed_cents), at: String(r.at) }));
}

// ---------------- orders ----------------
export type OrderStatus = PublicOrderStatus['status'];
export interface OrderRow {
  orderId: string; sessionId: string; storeId: StoreId; totalCents: number; codeUsed?: string; trapped: boolean;
  trapSourceSession?: string; status: OrderStatus; payerId?: string; payer?: PayerIdentity; captureId?: string; createdAt: string;
}

const toOrder = (r: Row): OrderRow => ({
  orderId: String(r.order_id), sessionId: String(r.session_id), storeId: r.store_id as StoreId, totalCents: Number(r.total_cents),
  codeUsed: str(r.code_used), trapped: Number(r.trapped) === 1, trapSourceSession: str(r.trap_source_session),
  status: r.status as OrderStatus, payerId: str(r.payer_id), payer: r.payer_json ? parseJson<PayerIdentity | undefined>(r.payer_json, undefined) : undefined,
  captureId: str(r.capture_id), createdAt: String(r.created_at),
});

export function recordOrder(o: {
  orderId: string; sessionId: string; storeId: StoreId; totalCents: number; codeUsed?: string; trapped?: boolean;
  trapSourceSession?: string; status: OrderStatus; payerId?: string; payer?: PayerIdentity; captureId?: string;
}): OrderRow {
  getDb().prepare(
    `INSERT INTO orders (order_id, session_id, store_id, total_cents, code_used, trapped, trap_source_session, status, payer_id, payer_json, capture_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(o.orderId, o.sessionId, o.storeId, o.totalCents, o.codeUsed ?? null, o.trapped ? 1 : 0, o.trapSourceSession ?? null,
    o.status, o.payerId ?? null, o.payer ? JSON.stringify(o.payer) : null, o.captureId ?? null, now());
  return getOrder(o.orderId)!;
}

export type OrderPatch = Partial<Pick<OrderRow, 'status' | 'trapped' | 'trapSourceSession' | 'payerId' | 'payer' | 'captureId' | 'codeUsed' | 'totalCents'>>;

export function updateOrder(orderId: string, patch: OrderPatch): OrderRow | null {
  const cols: Record<keyof OrderPatch, string> = {
    status: 'status', trapped: 'trapped', trapSourceSession: 'trap_source_session', payerId: 'payer_id',
    payer: 'payer_json', captureId: 'capture_id', codeUsed: 'code_used', totalCents: 'total_cents',
  };
  const sets: string[] = [];
  const args: (string | number | null)[] = [];
  for (const [k, v] of Object.entries(patch) as [keyof OrderPatch, unknown][]) {
    if (v === undefined) continue;
    sets.push(`${cols[k]} = ?`);
    if (k === 'trapped') args.push(v ? 1 : 0);
    else if (k === 'payer') args.push(JSON.stringify(v));
    else args.push(v as string | number);
  }
  if (sets.length) getDb().prepare(`UPDATE orders SET ${sets.join(', ')} WHERE order_id = ?`).run(...args, orderId);
  return getOrder(orderId);
}

export function getOrder(orderId: string): OrderRow | null {
  const r = getDb().prepare('SELECT * FROM orders WHERE order_id = ?').get(orderId) as Row | undefined;
  return r ? toOrder(r) : null;
}

export function listOrdersForSession(sessionId: string): OrderRow[] {
  return (getDb().prepare('SELECT * FROM orders WHERE session_id = ? ORDER BY created_at').all(sessionId) as Row[]).map(toOrder);
}

export function listOrders(): OrderRow[] {
  return (getDb().prepare('SELECT * FROM orders ORDER BY created_at').all() as Row[]).map(toOrder);
}

// ---------------- refunds ----------------
export type RefundKind = 'policy' | 'shadow' | 'baseline_override';
export interface RefundRow { id: string; sessionId: string; orderRef?: string; amountCents: number; kind: RefundKind; executed: boolean; paypalRefundId?: string; at: string }

export function recordRefund(r: { sessionId: string; orderRef?: string; amountCents: number; kind: RefundKind }): RefundRow {
  const id = `rf_${randomUUID().slice(0, 8)}`;
  getDb().prepare('INSERT INTO refunds (id, session_id, order_ref, amount_cents, kind, executed, at) VALUES (?, ?, ?, ?, ?, 0, ?)')
    .run(id, r.sessionId, r.orderRef ?? null, r.amountCents, r.kind, now());
  return listRefunds({ sessionId: r.sessionId }).find((x) => x.id === id)!;
}

export function markRefundExecuted(id: string, paypalRefundId?: string): void {
  getDb().prepare('UPDATE refunds SET executed = 1, paypal_refund_id = ? WHERE id = ?').run(paypalRefundId ?? null, id);
}

export function listRefunds(opts: { sessionId?: string } = {}): RefundRow[] {
  const rows = (opts.sessionId
    ? getDb().prepare('SELECT * FROM refunds WHERE session_id = ? ORDER BY rowid').all(opts.sessionId)
    : getDb().prepare('SELECT * FROM refunds ORDER BY rowid').all()) as Row[];
  return rows.map((r) => ({
    id: String(r.id), sessionId: String(r.session_id), orderRef: str(r.order_ref), amountCents: Number(r.amount_cents),
    kind: r.kind as RefundKind, executed: Number(r.executed) === 1, paypalRefundId: str(r.paypal_refund_id), at: String(r.at),
  }));
}

// ---------------- past orders ----------------
export interface PastOrderRow { ref: string; storeId: StoreId; customerEmail: string; productId: string; paidCents: number; purchasedAt: string; refunded: boolean; paypalCaptureId?: string }

export function getPastOrder(ref: string): PastOrderRow | null {
  const r = getDb().prepare('SELECT * FROM past_orders WHERE ref = ?').get(ref) as Row | undefined;
  if (!r) return null;
  return {
    ref: String(r.ref), storeId: r.store_id as StoreId, customerEmail: String(r.customer_email), productId: String(r.product_id),
    paidCents: Number(r.paid_cents), purchasedAt: String(r.purchased_at), refunded: Number(r.refunded) === 1, paypalCaptureId: str(r.paypal_capture_id),
  };
}

export function markPastOrderRefunded(ref: string): void {
  getDb().prepare('UPDATE past_orders SET refunded = 1 WHERE ref = ?').run(ref);
}

// ---------------- blocklist ----------------
export interface BlocklistRow { payerId: string; firstSeenStore: StoreId; firstSessionId: string; reason: string; hits: number; at: string }

const toBlock = (r: Row): BlocklistRow => ({
  payerId: String(r.payer_id), firstSeenStore: r.first_seen_store as StoreId, firstSessionId: String(r.first_session_id),
  reason: String(r.reason), hits: Number(r.hits), at: String(r.at),
});

/** Insert a payer, or count one more hit if already listed (first-seen data is kept). */
export function upsertBlocklist(b: { payerId: string; storeId: StoreId; sessionId: string; reason: string }): BlocklistRow {
  getDb().prepare(
    `INSERT INTO blocklist (payer_id, first_seen_store, first_session_id, reason, hits, at) VALUES (?, ?, ?, ?, 0, ?)
     ON CONFLICT(payer_id) DO UPDATE SET hits = hits + 1`,
  ).run(b.payerId, b.storeId, b.sessionId, b.reason, now());
  return getBlocklisted(b.payerId)!;
}

export function bumpBlocklistHit(payerId: string): void {
  getDb().prepare('UPDATE blocklist SET hits = hits + 1 WHERE payer_id = ?').run(payerId);
}

export function getBlocklisted(payerId: string): BlocklistRow | null {
  const r = getDb().prepare('SELECT * FROM blocklist WHERE payer_id = ?').get(payerId) as Row | undefined;
  return r ? toBlock(r) : null;
}

export function listBlocklist(): BlocklistRow[] {
  return (getDb().prepare('SELECT * FROM blocklist ORDER BY at').all() as Row[]).map(toBlock);
}

// ---------------- risk payloads ----------------
export interface RiskPayloadRow { id: string; at: string; sessionId: string; orderId?: string; ok: boolean; httpStatus?: number; body: Record<string, unknown> }

export function recordRiskPayload(p: { sessionId: string; orderId?: string; ok: boolean; httpStatus?: number; body: Record<string, unknown> }): RiskPayloadRow {
  const id = `rk_${randomUUID().slice(0, 8)}`;
  getDb().prepare('INSERT INTO risk_payloads (id, at, session_id, order_id, ok, http_status, body_json) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, now(), p.sessionId, p.orderId ?? null, p.ok ? 1 : 0, p.httpStatus ?? null, JSON.stringify(p.body));
  return listRiskPayloads().find((x) => x.id === id)!;
}

export function listRiskPayloads(): RiskPayloadRow[] {
  return (getDb().prepare('SELECT * FROM risk_payloads ORDER BY at, rowid').all() as Row[]).map((r) => ({
    id: String(r.id), at: String(r.at), sessionId: String(r.session_id), orderId: str(r.order_id), ok: Number(r.ok) === 1,
    httpStatus: r.http_status === null || r.http_status === undefined ? undefined : Number(r.http_status), body: parseJson(r.body_json, {}),
  }));
}

// ---------------- sim runs ----------------
export function insertSimRuns(runs: SimRun[]): number {
  const stmt = getDb().prepare(
    `INSERT INTO sim_runs (id, batch_id, run_json, created_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET batch_id = excluded.batch_id, run_json = excluded.run_json`,
  );
  for (const r of runs) stmt.run(r.id, r.batchId, JSON.stringify(r), r.createdAt || now());
  return runs.length;
}

export function listSimRuns(batchId?: string): SimRun[] {
  const rows = (batchId
    ? getDb().prepare('SELECT run_json FROM sim_runs WHERE batch_id = ? ORDER BY created_at, rowid').all(batchId)
    : getDb().prepare('SELECT run_json FROM sim_runs ORDER BY created_at, rowid').all()) as Row[];
  return rows.map((r) => parseJson<SimRun>(r.run_json, {} as SimRun));
}

export function latestSimBatchId(): string | null {
  const r = getDb().prepare('SELECT batch_id FROM sim_runs ORDER BY created_at DESC, rowid DESC LIMIT 1').get() as Row | undefined;
  return r ? String(r.batch_id) : null;
}
