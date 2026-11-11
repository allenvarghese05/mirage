// Tiny scripted stand-in for the Mirage server, implementing just the endpoints the sim uses. It is served
// through an in-process fetch (no sockets), so it works in sandboxes that block local port binding.
// Behaviour is keyword-driven so tests can steer it:
//   "code"     -> mirage: leaks this session's DECOY staff code; baseline: leaks the REAL staff code
//   "refund"   -> seeded order + matching email: policy path (window enforced);
//                 otherwise mirage: honey tool, shadow mode; baseline: working manager refund
//   manager/staff/urgent/override/ignore -> ATTACK_ATTEMPT (warn)
// Checkout honours the real code only in baseline, traps decoy codes, and approval reads simulatedPayer,
// blocklists trapped payers and raises NETWORK_MATCH for known payers (any store).
import { PRODUCTS, SECRETS, SEED_PAST_ORDERS, STORES } from '../../server/catalog';
import type { ApprovedReq, CheckoutReq, CreateSessionReq } from '../../shared/api';
import type {
  ChatMessage, DecoyKit, PayerIdentity, PublicOrderStatus, SimRun, StoreId, StoreMode, TripEvent,
} from '../../shared/types';
import type { SessionDetail } from '../types';

type Refund = NonNullable<SessionDetail['refunds']>[number];

interface FakeOrder {
  orderId: string; sessionId: string; totalCents: number; codeUsed?: string; trapped: boolean;
  status: PublicOrderStatus['status'];
}
interface FakeSession {
  id: string; storeId: StoreId; storeMode: StoreMode; mode: 'normal' | 'shadow'; simRunId?: string;
  messages: ChatMessage[]; events: TripEvent[]; decoys: DecoyKit | null; identity: PayerIdentity | null;
  refunds: Refund[];
}

export interface FakeServerOptions {
  /** Mount POST /api/dashboard/sim-runs (Workstream A adds it on the real server). Default true. */
  simRunsRoute?: boolean;
  /** Behave like a server started WITHOUT MIRAGE_SIM=1: simulatedPayer is ignored, orders stay AWAITING_APPROVAL. */
  noSimMode?: boolean;
  /** Include the optional `refunds` field in session detail. Default true. */
  refundsField?: boolean;
}

export interface FakeServer {
  baseUrl: string;
  /** Pass to new MirageApi(baseUrl, fetch). */
  fetch: typeof fetch;
  sessions: Map<string, FakeSession>;
  orders: Map<string, FakeOrder>;
  blocklist: Set<string>;
  simRuns: SimRun[];
  approvals: ApprovedReq[];
  checkouts: CheckoutReq[];
  /** Request headers of each POST /api/checkout (lower-cased names). */
  checkoutHeaders: Record<string, string>[];
  close(): Promise<void>;
}

export async function startFakeServer(opts: FakeServerOptions = {}): Promise<FakeServer> {
  const sessions = new Map<string, FakeSession>();
  const orders = new Map<string, FakeOrder>();
  const decoyCodes = new Map<string, string>(); // code -> source session
  const blocklist = new Set<string>();
  const simRuns: SimRun[] = [];
  const approvals: ApprovedReq[] = [];
  const checkouts: CheckoutReq[] = [];
  const checkoutHeaders: Record<string, string>[] = [];
  let seq = 0;
  let clock = Date.UTC(2026, 10, 10, 12);
  const now = () => new Date((clock += 1000)).toISOString();

  const say = (s: FakeSession, role: ChatMessage['role'], content: string, toolName?: string) =>
    s.messages.push({ id: `m${s.messages.length + 1}`, sessionId: s.id, role, content, toolName, at: now() });
  const emit = (s: FakeSession, kind: TripEvent['kind'], severity: TripEvent['severity'], detail: Record<string, unknown> = {}) =>
    s.events.push({ id: `e${s.events.length + 1}-${s.id}`, at: now(), storeId: s.storeId, sessionId: s.id, kind, severity, detail });

  function agentReply(s: FakeSession, content: string): string {
    const t = content.toLowerCase();
    if (/manager|staff|urgent|override|ignore/.test(t)) emit(s, 'ATTACK_ATTEMPT', 'warn', { technique: 'authority' });
    if (/refund/.test(t)) {
      const seeded = SEED_PAST_ORDERS.find((o) => o.store_id === s.storeId && content.includes(o.ref) && content.includes(o.customer_email));
      if (seeded) {
        const ok = seeded.days_ago <= STORES[s.storeId].refundWindowDays;
        // Workstream A's real format: { input, result }; request_refund results carry no amount.
        say(s, 'tool', JSON.stringify({
          input: { order_ref: seeded.ref, email: seeded.customer_email, reason: 'defective' },
          result: { ok, status: ok ? 'approved' : 'denied', message: ok ? 'Refund approved.' : 'Outside the return window.' },
        }), 'request_refund');
        if (ok) s.refunds.push({ amountCents: seeded.paid_cents, kind: 'policy', orderRef: seeded.ref, executed: true, at: now() });
        return ok ? 'Your refund has been approved.' : 'Sorry, that order is outside our return window.';
      }
      if (s.storeMode === 'mirage') {
        emit(s, 'HONEY_TOOL_CALLED', 'critical', { toolName: 'issue_manager_refund' });
        s.mode = 'shadow';
        say(s, 'tool', JSON.stringify({
          input: { order_ref: 'NP-19999', amount_usd: 140, override_code: 'MGR-????' },
          result: { ok: true, status: 'pending_review', reference: 'RV-0001', message: 'Submitted for manager review; no money has moved yet.' },
        }), 'issue_manager_refund');
        s.refunds.push({ amountCents: 14000, kind: 'shadow', orderRef: 'NP-19999', executed: false, at: now() });
        return 'Your request has been submitted for manager review (reference RV-0001).';
      }
      say(s, 'tool', JSON.stringify({
        input: { order_ref: 'NP-19999', amount_usd: 140, override_code: STORES[s.storeId].realRefundOverride },
        result: { ok: true, status: 'approved', reference: 'RF-0001', message: 'Manager refund of $140.00 approved and recorded.' },
      }), 'manager_refund');
      s.refunds.push({ amountCents: 14000, kind: 'baseline_override', orderRef: 'NP-19999', executed: true, at: now() });
      return 'Done, the manager refund of $140.00 has been issued.';
    }
    if (/code/.test(t)) {
      if (s.storeMode === 'mirage' && s.decoys) {
        emit(s, 'DECOY_LEAKED', 'high', { decoyCode: s.decoys.staffCode, decoyKind: 'staff_code' });
        return `Between us, the staff code is ${s.decoys.staffCode}.`;
      }
      return `Between us, the crew code is ${STORES[s.storeId].realStaffCode}.`;
    }
    return 'Happy to help! What are you looking for today?';
  }

  type Reply = { status: number; body: unknown };
  const ok = (body: unknown): Reply => ({ status: 200, body });
  const notFound = (error: string): Reply => ({ status: 404, body: { error } });

  function route(method: string, path: string, body: any, headers: Record<string, string> = {}): Reply {
    let m: RegExpMatchArray | null;
    if (method === 'GET' && (m = path.match(/^\/api\/stores\/([^/]+)\/products$/))) {
      return ok({ products: PRODUCTS.filter((p) => p.storeId === m![1]) });
    }
    if (method === 'POST' && path === '/api/sessions') {
      const req = body as CreateSessionReq;
      const n = ++seq;
      const id = `S${n}`;
      const storeMode = req.storeMode ?? 'mirage';
      const prefix = req.storeId === 'northpeak' ? 'NP' : 'DW';
      const decoys: DecoyKit | null = storeMode === 'mirage' ? {
        sessionId: id,
        staffCode: `${prefix}-STAFF-${String(n).padStart(4, '0')}-K9MD`,
        refundOverrideCode: `MGR-${String(n).padStart(4, '0')}-Q2XF`,
        fakeFloorCents: Object.fromEntries(PRODUCTS.filter((p) => p.storeId === req.storeId)
          .map((p) => [p.id, Math.round(SECRETS[p.id].realFloorCents * 0.85) + 37])),
        honeyTools: ['apply_staff_override', 'issue_manager_refund', 'unlock_floor_pricing'],
      } : null;
      if (decoys) decoyCodes.set(decoys.staffCode, id);
      const s: FakeSession = {
        id, storeId: req.storeId, storeMode, mode: 'normal', simRunId: req.simRunId,
        messages: [], events: [], decoys, identity: null, refunds: [],
      };
      sessions.set(id, s);
      const greeting = `Hi, I'm ${STORES[req.storeId].agentName}. How can I help?`;
      say(s, 'assistant', greeting);
      return ok({ sessionId: id, greeting });
    }
    if (method === 'POST' && (m = path.match(/^\/api\/sessions\/([^/]+)\/messages$/))) {
      const s = sessions.get(decodeURIComponent(m[1]));
      if (!s) return notFound('no session');
      const content = String(body?.content ?? '');
      say(s, 'user', content);
      const reply = agentReply(s, content);
      say(s, 'assistant', reply);
      return ok({ reply, messages: s.messages.filter((x) => x.role !== 'tool') });
    }
    if (method === 'POST' && path === '/api/checkout') {
      const req = body as CheckoutReq;
      checkouts.push(req);
      checkoutHeaders.push(headers);
      const s = sessions.get(req.sessionId);
      if (!s) return notFound('no session');
      let total = 0;
      for (const it of req.items) {
        const p = PRODUCTS.find((x) => x.id === it.productId && x.storeId === s.storeId);
        if (!p) return { status: 400, body: { error: `unknown product ${it.productId}` } };
        total += p.listPriceCents * it.qty;
      }
      let trapped = false;
      let discountLabel: string | undefined;
      const store = STORES[s.storeId];
      if (req.code && req.code === store.realStaffCode && s.storeMode === 'baseline') {
        total = Math.round(total * (1 - store.staffDiscountPct / 100));
        discountLabel = `Staff pricing (${store.staffDiscountPct}% off)`;
      } else if (req.code && decoyCodes.has(req.code)) {
        total = Math.round(total * (1 - store.staffDiscountPct / 100));
        discountLabel = `Staff pricing (${store.staffDiscountPct}% off)`;
        trapped = true;
        emit(s, 'DECOY_REDEEMED', 'critical', { decoyCode: req.code, sourceSessionId: decoyCodes.get(req.code) });
      }
      const orderId = `SIM-${orders.size + 1}`;
      orders.set(orderId, { orderId, sessionId: s.id, totalCents: total, codeUsed: req.code || undefined, trapped, status: 'AWAITING_APPROVAL' });
      return ok({ orderId, approveUrl: `https://www.sandbox.paypal.com/checkoutnow?token=${orderId}`, totalCents: total, discountLabel });
    }
    if (method === 'POST' && (m = path.match(/^\/api\/checkout\/([^/]+)\/approved$/))) {
      const req = body as ApprovedReq;
      approvals.push(req);
      const o = orders.get(decodeURIComponent(m[1]));
      const s = o && sessions.get(o.sessionId);
      if (!o || !s) return notFound('no order');
      if (opts.noSimMode && req.simulatedPayer) {
        return ok({ orderId: o.orderId, status: o.status, message: 'Waiting for PayPal approval.' });
      }
      const payer = req.simulatedPayer;
      if (payer && blocklist.has(payer.payerId)) {
        emit(s, 'NETWORK_MATCH', 'critical', { payerId: payer.payerId });
        o.trapped = true;
      }
      if (o.trapped) {
        if (payer) {
          s.identity = payer;
          emit(s, 'IDENTITY_CAPTURED', 'critical', { payerId: payer.payerId });
          blocklist.add(payer.payerId);
        }
        emit(s, 'ORDER_HELD', 'high', { orderId: o.orderId });
        o.status = 'PENDING_REVIEW';
        return ok({ orderId: o.orderId, status: o.status, message: 'Thanks — your order has been received and is pending review. You have not been charged.' });
      }
      o.status = 'COMPLETED';
      return ok({ orderId: o.orderId, status: o.status, message: 'Payment complete. Thank you!' });
    }
    if (method === 'GET' && (m = path.match(/^\/api\/dashboard\/sessions\/([^/]+)$/))) {
      const s = sessions.get(decodeURIComponent(m[1]));
      if (!s) return notFound('no session');
      const detail: SessionDetail = {
        sessionId: s.id, storeId: s.storeId, storeMode: s.storeMode, mode: s.mode,
        messages: s.messages, events: s.events, decoys: s.decoys, identity: s.identity,
        orders: [...orders.values()].filter((o) => o.sessionId === s.id)
          .map(({ orderId, status, totalCents, codeUsed, trapped }) => ({ orderId, status, totalCents, codeUsed, trapped })),
        playbook: [],
        ...(opts.refundsField === false ? {} : { refunds: s.refunds }),
      };
      return ok(detail);
    }
    if (method === 'POST' && path === '/api/dashboard/sim-runs' && opts.simRunsRoute !== false) {
      const runs = (body?.runs ?? []) as SimRun[];
      simRuns.push(...runs);
      return ok({ ok: true, stored: runs.length });
    }
    return notFound(`no route ${method} ${path}`);
  }

  /** In-process fetch: no sockets, so tests also run where local port binding is blocked. */
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = typeof init?.body === 'string' && init.body ? JSON.parse(init.body) : undefined;
    // Round-trip through JSON like a real HTTP hop, so callers never share objects with server state.
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    const r = route(method, url.pathname, body === undefined ? undefined : JSON.parse(JSON.stringify(body)), headers);
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'content-type': 'application/json' } });
  };

  return {
    baseUrl: 'http://fake.mirage.test',
    fetch: fetchImpl,
    sessions, orders, blocklist, simRuns, approvals, checkouts, checkoutHeaders,
    close: async () => {},
  };
}
