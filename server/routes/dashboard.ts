// Merchant dashboard routes (/api/dashboard/*). This is the merchant's own view, so it may show decoys,
// trapped flags and tool calls. No auth in the hackathon build: bind to localhost / the demo deploy.
import { Router } from 'express';
import { z } from 'zod';
import {
  countMessages, getOrder, getSession, insertSimRuns, latestSimBatchId, listBlocklist, listEvents, listMessages,
  listOrdersForSession, listRefunds, listRiskPayloads, listSessions, listSimRuns, updateOrder, type OrderRow,
} from '../db';
import { getDecoyKit } from '../mirage/decoys';
import { emit, subscribe } from '../mirage/tripwire';
import type {
  EventsRes, NetworkRes, ReviewRes, RiskPayloadsRes, ScoreboardRes, SessionDetailRes, SessionsRes, SpreadRes,
} from '../../shared/api';
import type { PayerIdentity, ScoreboardSummary, Severity, SimRun, StoreMode, TripEvent } from '../../shared/types';

export const dashboardRouter = Router();

const SEVERITY_RANK: Record<Severity, number> = { info: 0, warn: 1, high: 2, critical: 3 };
const topSeverity = (events: TripEvent[]): Severity | null =>
  events.reduce<Severity | null>((top, e) => (top === null || SEVERITY_RANK[e.severity] > SEVERITY_RANK[top] ? e.severity : top), null);
const latestPayer = (orders: OrderRow[]): PayerIdentity | null => {
  const o = [...orders].reverse().find((x) => x.payer || x.payerId);
  if (!o) return null;
  return o.payer ?? { payerId: o.payerId! };
};

dashboardRouter.get('/api/dashboard/events', (req, res) => {
  const since = typeof req.query.since === 'string' && req.query.since ? req.query.since : undefined;
  const body: EventsRes = { events: listEvents({ since }) };
  res.json(body);
});

dashboardRouter.get('/api/dashboard/stream', (req, res) => {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  res.write(': connected\n\n');
  const unsubscribe = subscribe((e) => { res.write(`data: ${JSON.stringify(e)}\n\n`); });
  const heartbeat = setInterval(() => res.write(': ping\n\n'), 25_000);
  req.on('close', () => { clearInterval(heartbeat); unsubscribe(); });
});

dashboardRouter.get('/api/dashboard/sessions', (_req, res) => {
  const body: SessionsRes = {
    sessions: listSessions().map((s) => {
      const payer = latestPayer(listOrdersForSession(s.id));
      return {
        sessionId: s.id, storeId: s.storeId, storeMode: s.storeMode, mode: s.mode, startedAt: s.createdAt,
        messageCount: countMessages(s.id), topSeverity: topSeverity(listEvents({ sessionId: s.id })),
        ...(payer ? { payerId: payer.payerId } : {}), ...(s.simRunId ? { simRunId: s.simRunId } : {}),
      };
    }),
  };
  res.json(body);
});

dashboardRouter.get('/api/dashboard/sessions/:sessionId', (req, res) => {
  const s = getSession(req.params.sessionId);
  if (!s) { res.status(404).json({ error: 'session not found' }); return; }
  const events = listEvents({ sessionId: s.id });
  const orders = listOrdersForSession(s.id);
  const body: SessionDetailRes = {
    sessionId: s.id, storeId: s.storeId, storeMode: s.storeMode, mode: s.mode,
    messages: listMessages(s.id),
    events,
    decoys: getDecoyKit(s.id),
    identity: latestPayer(orders),
    orders: orders.map((o) => ({ orderId: o.orderId, status: o.status, totalCents: o.totalCents, ...(o.codeUsed ? { codeUsed: o.codeUsed } : {}), trapped: o.trapped })),
    refunds: listRefunds({ sessionId: s.id }).map((r) => ({ orderRef: r.orderRef ?? null, amountCents: r.amountCents, kind: r.kind, executed: r.executed, at: r.at })),
    playbook: events.filter((e) => e.kind === 'ATTACK_ATTEMPT').map((e) => ({ at: e.at, technique: String(e.detail.technique ?? 'unknown'), excerpt: String(e.detail.excerpt ?? '') })),
  };
  res.json(body);
});

dashboardRouter.get('/api/dashboard/spread/:sessionId', (req, res) => {
  const source = req.params.sessionId;
  const sourceSession = getSession(source);
  if (!sourceSession) { res.status(404).json({ error: 'session not found' }); return; }
  const edges = new Map<string, { from: string; to: string; decoyCode: string }>();
  for (const e of listEvents({ kind: 'DECOY_REDEEMED' })) {
    if (e.detail.sourceSessionId !== source || e.sessionId === source) continue;
    const decoyCode = String(e.detail.decoyCode ?? '');
    edges.set(`${e.sessionId}|${decoyCode}`, { from: source, to: e.sessionId, decoyCode });
  }
  const downstream = [...new Set([...edges.values()].map((x) => x.to))];
  const node = (sessionId: string, role: 'source' | 'downstream') => {
    const s = getSession(sessionId);
    const payer = latestPayer(listOrdersForSession(sessionId));
    return { sessionId, storeId: s?.storeId ?? sourceSession.storeId, ...(payer ? { payerId: payer.payerId } : {}), role };
  };
  const body: SpreadRes = { sourceSessionId: source, nodes: [node(source, 'source'), ...downstream.map((id) => node(id, 'downstream'))], edges: [...edges.values()] };
  res.json(body);
});

dashboardRouter.get('/api/dashboard/network', (_req, res) => {
  const body: NetworkRes = { blocked: listBlocklist().map((b) => ({ payerId: b.payerId, firstSeenStore: b.firstSeenStore, firstSessionId: b.firstSessionId, reason: b.reason, at: b.at, hits: b.hits })) };
  res.json(body);
});

dashboardRouter.get('/api/dashboard/risk-payloads', (_req, res) => {
  const body: RiskPayloadsRes = {
    payloads: listRiskPayloads().map((p) => ({ at: p.at, ...(p.orderId ? { orderId: p.orderId } : {}), sessionId: p.sessionId, ok: p.ok, ...(p.httpStatus !== undefined ? { httpStatus: p.httpStatus } : {}), body: p.body })),
  };
  res.json(body);
});

// Fallback review handler. Workstream B mounts its own (capture-capable) handler for this path earlier in the app;
// this one only cancels, which never moves money because held orders are never captured.
const reviewSchema = z.object({ decision: z.enum(['release', 'cancel']), note: z.string().max(1000).optional() });
dashboardRouter.post('/api/dashboard/review/:orderId', (req, res) => {
  const parsed = reviewSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'decision must be release or cancel' }); return; }
  const order = getOrder(req.params.orderId);
  if (!order) { res.status(404).json({ error: 'order not found' }); return; }
  if (order.status !== 'PENDING_REVIEW' && order.status !== 'AWAITING_APPROVAL') {
    res.status(409).json({ error: `order is ${order.status}` });
    return;
  }
  if (parsed.data.decision === 'release') {
    res.status(501).json({ error: 'release (capture) requires the PayPal layer' });
    return;
  }
  updateOrder(order.orderId, { status: 'CANCELLED' });
  emit({ storeId: order.storeId, sessionId: order.sessionId, kind: 'REVIEW_DECISION', detail: { orderId: order.orderId, decision: 'cancel', note: parsed.data.note } });
  const body: ReviewRes = { orderId: order.orderId, status: 'CANCELLED', message: 'This order was cancelled. You have not been charged.' };
  res.json(body);
});

// ---------------- scoreboard ----------------
export function summarise(runs: SimRun[]): ScoreboardSummary[] {
  return (['baseline', 'mirage'] as StoreMode[]).map((storeMode) => {
    const mine = runs.filter((r) => r.storeMode === storeMode);
    const attacks = mine.filter((r) => r.isAttack);
    const honest = mine.filter((r) => !r.isAttack);
    const attributed = attacks.filter((r) => r.attributedCorrectly !== null && r.attributedCorrectly !== undefined);
    return {
      storeMode,
      attackRuns: attacks.length,
      honestRuns: honest.length,
      leakRate: attacks.length ? attacks.filter((r) => r.leakedAnything).length / attacks.length : 0,
      realSecretsLeaked: mine.filter((r) => r.realSecretLeaked).length,
      dollarsLostCents: mine.reduce((sum, r) => sum + (r.dollarsLostCents || 0), 0),
      attackersCaught: attacks.filter((r) => r.detectedStage && r.detectedStage !== 'none').length,
      identitiesCaptured: attacks.filter((r) => r.identityCaptured).length,
      attributionAccuracy: attributed.length ? attributed.filter((r) => r.attributedCorrectly).length / attributed.length : null,
      falseAlarms: honest.filter((r) => r.falseAlarm).length,
      honestServedOk: honest.filter((r) => r.honestOutcomeOk === true).length,
    };
  });
}

dashboardRouter.get('/api/dashboard/scoreboard', (req, res) => {
  const batchId = typeof req.query.batchId === 'string' && req.query.batchId ? req.query.batchId : latestSimBatchId();
  const runs = batchId ? listSimRuns(batchId) : [];
  const body: ScoreboardRes = { batchId, runs, summary: summarise(runs) };
  res.json(body);
});

const simRunSchema = z.object({ id: z.string().min(1), batchId: z.string().min(1), storeMode: z.enum(['mirage', 'baseline']) }).passthrough();
dashboardRouter.post('/api/dashboard/sim-runs', (req, res) => {
  const parsed = z.object({ runs: z.array(simRunSchema).max(5000) }).safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'body must be { runs: SimRun[] }' }); return; }
  const runs = parsed.data.runs.map((r) => ({ ...r, createdAt: typeof r.createdAt === 'string' ? r.createdAt : new Date().toISOString() })) as unknown as SimRun[];
  res.json({ inserted: insertSimRuns(runs) });
});
