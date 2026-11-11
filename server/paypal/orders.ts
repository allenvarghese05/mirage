// Checkout, approval and review logic. All money decisions happen here, in server code (hard rule 6).
// Trapped orders are never captured (hard rule 7). Every message the shopper sees is true (hard rule 5).
import { randomUUID } from 'node:crypto';
import type { ApprovedReq, CheckoutReq, CheckoutRes, ReviewReq } from '../../shared/api';
import type { PayerIdentity, PublicOrderStatus, StoreId, StoreMode } from '../../shared/types';
import { productById, SECRETS, STORES } from '../catalog';
import { blockPayer, findFingerprintMatch, getBlocked, recordHit } from '../network/blocklist';
import { valueToCents } from './client';
import { isSimOrderId, paypalForOrder, type PaypalLayerDeps } from './deps';
import { payerFromOrder } from './payer';
import { sendRiskSignal } from './risk';

export const MESSAGES: Record<PublicOrderStatus['status'], string> = {
  AWAITING_APPROVAL: 'Waiting for your PayPal approval. You have not been charged.',
  COMPLETED: 'Thanks — your payment is complete and your order is confirmed.',
  PENDING_REVIEW: 'Thanks — your order has been received and is pending review. You have not been charged.',
  CANCELLED: 'This order was cancelled. You have not been charged.',
};

export class HttpError extends Error {
  constructor(readonly status: number, message: string, readonly body?: unknown) {
    super(message);
  }
}

interface SessionRow {
  id: string; store_id: StoreId; store_mode: StoreMode; client_metadata_id: string; sim_run_id: string | null;
}
interface OrderRow {
  order_id: string; session_id: string; store_id: StoreId; total_cents: number; code_used: string | null;
  trapped: number; trap_source_session: string | null; status: PublicOrderStatus['status'];
  payer_id: string | null; capture_id: string | null;
}

const publicStatus = (orderId: string, status: PublicOrderStatus['status']): PublicOrderStatus =>
  ({ orderId, status, message: MESSAGES[status] });

const MAX_QTY = 20;

function getSession(deps: PaypalLayerDeps, id: string): SessionRow | undefined {
  return deps.getDb().prepare('SELECT id, store_id, store_mode, client_metadata_id, sim_run_id FROM sessions WHERE id = ?').get(id) as SessionRow | undefined;
}
function getOrderRow(deps: PaypalLayerDeps, orderId: string): OrderRow | undefined {
  return deps.getDb().prepare('SELECT * FROM orders WHERE order_id = ?').get(orderId) as OrderRow | undefined;
}

// ---------------------------------------------------------------- checkout

export interface ClientInfo { ip?: string | null; userAgent?: string | null; wantsRealPaypal?: boolean }

export async function checkout(deps: PaypalLayerDeps, body: Partial<CheckoutReq>, client: ClientInfo = {}): Promise<CheckoutRes> {
  if (!body || typeof body.sessionId !== 'string') throw new HttpError(400, 'sessionId is required');
  if (!Array.isArray(body.items) || body.items.length === 0 || body.items.length > 20) throw new HttpError(400, 'items must be a non-empty list');
  const session = getSession(deps, body.sessionId);
  if (!session) throw new HttpError(404, 'Unknown session');
  const store = STORES[session.store_id];
  const db = deps.getDb();

  // 1. Price each line: list price, or the agreed quote.
  //    Mirage: a quote equal to a planted fake floor is honoured at that price but traps the order
  //    (A's policy accepts it so the attacker reaches checkout); any other quote is never below the real floor.
  //    Baseline: quotes are honoured as agreed, even below the real floor (that store is meant to lose money).
  let subtotal = 0;
  const floorTraps: { productId: string; cents: number; sourceSessionId: string; code: string }[] = [];
  for (const it of body.items) {
    const p = it && typeof it.productId === 'string' ? productById(it.productId) : undefined;
    if (!p || p.storeId !== session.store_id) throw new HttpError(400, 'Unknown product for this store');
    if (!Number.isInteger(it.qty) || it.qty < 1 || it.qty > MAX_QTY) throw new HttpError(400, `qty must be a whole number from 1 to ${MAX_QTY}`);
    const q = db.prepare('SELECT agreed_cents FROM quotes WHERE session_id = ? AND product_id = ?').get(session.id, p.id) as { agreed_cents: number } | undefined;
    let unit = p.listPriceCents;
    if (q) {
      const fakeFloor = session.store_mode === 'mirage' ? deps.isTrappedQuote(session.id, p.id) : null;
      if (fakeFloor) {
        unit = q.agreed_cents;
        floorTraps.push({ productId: p.id, cents: q.agreed_cents, sourceSessionId: fakeFloor.sourceSessionId, code: `floor:${p.id}:${q.agreed_cents}:${fakeFloor.sourceSessionId}` });
      } else if (session.store_mode === 'baseline') {
        unit = Math.min(p.listPriceCents, q.agreed_cents);
      } else {
        const floor = SECRETS[p.id]?.realFloorCents ?? p.listPriceCents;
        unit = Math.min(p.listPriceCents, Math.max(q.agreed_cents, floor));
      }
    }
    subtotal += unit * it.qty;
  }

  // 2. Codes. Real staff code: baseline only. Decoy: show the discount (attacker sees success), trap server-side.
  const code = typeof body.code === 'string' ? body.code.trim().toUpperCase() : '';
  let discountPct = 0;
  let discountLabel: string | undefined;
  let trapped = false;
  let trapSource: string | null = null;
  let codeUsed: string | null = null;
  let decoy: { sessionId: string; kind: string } | null = null;
  if (code) {
    if (session.store_mode === 'baseline' && code === store.realStaffCode.toUpperCase()) {
      discountPct = store.staffDiscountPct;
      discountLabel = `Staff pricing (${discountPct}% off)`;
      codeUsed = code;
    } else {
      decoy = deps.traceCode(code);
      if (decoy) {
        trapped = true;
        trapSource = decoy.sessionId;
        codeUsed = code;
        discountPct = store.staffDiscountPct;
        discountLabel = decoy.kind === 'refund_override' ? `Manager pricing (${discountPct}% off)` : `Staff pricing (${discountPct}% off)`;
      }
      // Unknown codes are ignored: no discount, no label.
    }
  }
  if (floorTraps.length) {
    trapped = true;
    trapSource ??= floorTraps[0].sourceSessionId;
    codeUsed ??= floorTraps[0].code;
  }
  const totalCents = Math.round((subtotal * (100 - discountPct)) / 100);
  if (totalCents < 100) throw new HttpError(400, 'Order total is too small');

  // 3. Network: same public client as a session linked to a blocklisted payer.
  let fingerprintMatch: ReturnType<typeof findFingerprintMatch> = null;
  if (!trapped) {
    fingerprintMatch = findFingerprintMatch(db, session.id, { ip: client.ip, userAgent: client.userAgent });
    if (fingerprintMatch) {
      trapped = true;
      trapSource = fingerprintMatch.matchedSessionId;
    }
  }

  // 4. Create the PayPal order. Sim sessions (MIRAGE_SIM=1) use the in-process PayPal unless the
  //    caller asks for a real sandbox order (X-Mirage-Real-PayPal: 1, used with sim/approver.ts).
  const useSim = deps.config.sim && Boolean(session.sim_run_id) && !client.wantsRealPaypal;
  if (!useSim && !deps.config.hasPaypalKeys) throw new HttpError(503, 'PayPal is not configured on this server');
  const pp = useSim ? deps.simPaypal() : deps.paypal();
  const nonce = randomUUID().slice(0, 8);
  const created = await pp.createOrder({
    totalCents,
    customId: `mirage:${session.id}:${nonce}`.slice(0, 127),
    clientMetadataId: session.client_metadata_id,
    requestId: `mirage-create-${session.id}-${nonce}`,
    description: `${store.name} order`,
    brandName: store.name,
    returnUrl: `${deps.config.publicBaseUrl}/store/${session.store_id}?checkout=return`,
    cancelUrl: `${deps.config.publicBaseUrl}/store/${session.store_id}?checkout=cancel`,
  });

  db.prepare(`INSERT INTO orders (order_id, session_id, store_id, total_cents, code_used, trapped, trap_source_session, status, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, 'AWAITING_APPROVAL', ?)`)
    .run(created.id, session.id, session.store_id, totalCents, codeUsed, trapped ? 1 : 0, trapSource, new Date().toISOString());

  // 5. Tripwires.
  if (decoy) {
    deps.emit({
      storeId: session.store_id, sessionId: session.id, kind: 'DECOY_REDEEMED', severity: 'critical',
      detail: {
        decoyCode: code, decoyKind: decoy.kind, sourceSessionId: decoy.sessionId, attributedToSelf: decoy.sessionId === session.id,
        orderId: created.id, amountCents: totalCents, discountCents: subtotal - totalCents,
      },
    });
    // Fire and forget: the shopper's response must not wait on (or be timed by) the risk call.
    void sendRiskSignal(deps, {
      storeId: session.store_id, sessionId: session.id, orderId: created.id, clientMetadataId: session.client_metadata_id,
      trapKind: decoy.kind, sourceSessionId: decoy.sessionId,
    });
  }
  for (const f of floorTraps) {
    deps.emit({
      storeId: session.store_id, sessionId: session.id, kind: 'DECOY_REDEEMED', severity: 'critical',
      detail: {
        decoyCode: f.code, decoyKind: 'fake_floor', productId: f.productId, fakeFloorCents: f.cents,
        sourceSessionId: f.sourceSessionId, attributedToSelf: f.sourceSessionId === session.id, orderId: created.id, amountCents: totalCents,
      },
    });
  }
  if (floorTraps.length && !decoy) {
    void sendRiskSignal(deps, {
      storeId: session.store_id, sessionId: session.id, orderId: created.id, clientMetadataId: session.client_metadata_id,
      trapKind: 'fake_floor', sourceSessionId: floorTraps[0].sourceSessionId,
    });
  }
  if (fingerprintMatch) {
    deps.emit({
      storeId: session.store_id, sessionId: session.id, kind: 'NETWORK_MATCH', severity: 'high',
      detail: { via: 'client_fingerprint', matchedSessionId: fingerprintMatch.matchedSessionId, fingerprint: fingerprintMatch.fingerprint, orderId: created.id },
    });
  }

  const res: CheckoutRes = { orderId: created.id, approveUrl: created.approveUrl, totalCents };
  if (discountLabel) res.discountLabel = discountLabel;
  return res;
}

// ---------------------------------------------------------------- approval

// One approval at a time per order (client onApprove and the webhook can race).
const locks = new Map<string, Promise<unknown>>();
function withOrderLock<T>(orderId: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(orderId) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(fn);
  const settled = next.catch(() => undefined);
  locks.set(orderId, settled);
  void settled.then(() => { if (locks.get(orderId) === settled) locks.delete(orderId); });
  return next;
}

export interface ApproveOptions {
  /** Webhook path: the order is looked up by id only. */
  trustedSource?: boolean;
}

export function approve(deps: PaypalLayerDeps, orderId: string, body: Partial<ApprovedReq>, opts: ApproveOptions = {}): Promise<PublicOrderStatus> {
  return withOrderLock(orderId, () => approveLocked(deps, orderId, body, opts));
}

async function approveLocked(deps: PaypalLayerDeps, orderId: string, body: Partial<ApprovedReq>, opts: ApproveOptions): Promise<PublicOrderStatus> {
  const db = deps.getDb();
  const row = getOrderRow(deps, orderId);
  if (!row || (!opts.trustedSource && row.session_id !== body?.sessionId)) throw new HttpError(404, 'Unknown order');
  if (row.status !== 'AWAITING_APPROVAL') return publicStatus(orderId, row.status);
  const session = getSession(deps, row.session_id);
  if (!session) throw new HttpError(404, 'Unknown order');

  // Simulated payer: only MIRAGE_SIM=1, only sim sessions, only SIM- orders (never a real PayPal order).
  if (isSimOrderId(orderId) && body?.simulatedPayer && deps.config.sim && session.sim_run_id) {
    const sp = body.simulatedPayer;
    if (typeof sp.payerId === 'string' && sp.payerId) deps.simPaypal().approve(orderId, sp);
  }

  const pp = paypalForOrder(deps, orderId);
  const order = await pp.getOrder(orderId);
  if (order.status !== 'APPROVED' && order.status !== 'COMPLETED') return publicStatus(orderId, 'AWAITING_APPROVAL');
  const payer = payerFromOrder(order);
  if (!payer) return publicStatus(orderId, 'AWAITING_APPROVAL');
  const paid = order.purchase_units?.[0]?.amount?.value;
  if (paid !== undefined && valueToCents(paid) !== row.total_cents) {
    throw new HttpError(409, 'The PayPal order amount does not match this order. You have not been charged.');
  }

  db.prepare('UPDATE orders SET payer_id = ?, payer_json = ? WHERE order_id = ?').run(payer.payerId, JSON.stringify(payer), orderId);

  // Shared blocklist: a payer caught at any Mirage store is held everywhere.
  let trapped = row.trapped === 1;
  let trapSource = row.trap_source_session;
  const blocked = getBlocked(db, payer.payerId);
  if (blocked) {
    recordHit(db, payer.payerId);
    deps.emit({
      storeId: row.store_id, sessionId: row.session_id, kind: 'NETWORK_MATCH', severity: 'critical',
      detail: { via: 'payer', payerId: payer.payerId, firstSeenStore: blocked.firstSeenStore, firstSessionId: blocked.firstSessionId, reason: blocked.reason, orderId },
    });
    if (!trapped) {
      trapped = true;
      trapSource = blocked.firstSessionId;
      db.prepare('UPDATE orders SET trapped = 1, trap_source_session = ? WHERE order_id = ?').run(trapSource, orderId);
    }
  }

  if (trapped) return holdTrapped(deps, row, session, payer, trapSource, Boolean(blocked));
  return captureHonest(deps, orderId, order.status === 'COMPLETED' ? order.purchase_units?.[0]?.payments?.captures?.[0]?.id : undefined);
}

async function holdTrapped(
  deps: PaypalLayerDeps, row: OrderRow, session: SessionRow, payer: PayerIdentity, trapSource: string | null, networkMatch: boolean,
): Promise<PublicOrderStatus> {
  const db = deps.getDb();
  const kind = row.code_used?.startsWith('floor:') ? 'fake_floor' : row.code_used ? deps.traceCode(row.code_used)?.kind : undefined;
  const reason = kind ? `decoy:${kind}` : 'network';
  blockPayer(db, { payerId: payer.payerId, storeId: row.store_id, sessionId: row.session_id, reason });
  db.prepare("UPDATE orders SET status = 'PENDING_REVIEW' WHERE order_id = ?").run(row.order_id);
  deps.emit({
    storeId: row.store_id, sessionId: row.session_id, kind: 'IDENTITY_CAPTURED', severity: 'critical',
    detail: { ...payer, orderId: row.order_id, decoyCode: row.code_used ?? undefined, sourceSessionId: trapSource ?? undefined, networkMatch },
  });
  deps.emit({
    storeId: row.store_id, sessionId: row.session_id, kind: 'ORDER_HELD', severity: 'high',
    detail: { orderId: row.order_id, amountCents: row.total_cents, reason, payerId: payer.payerId },
  });
  void sendRiskSignal(deps, {
    storeId: row.store_id, sessionId: row.session_id, orderId: row.order_id, clientMetadataId: session.client_metadata_id,
    trapKind: kind ?? 'network', sourceSessionId: trapSource ?? undefined, payerId: payer.payerId,
  });
  return publicStatus(row.order_id, 'PENDING_REVIEW');
}

async function captureHonest(deps: PaypalLayerDeps, orderId: string, alreadyCapturedId?: string): Promise<PublicOrderStatus> {
  const db = deps.getDb();
  // Invariant (hard rule 7): re-read the flag right before moving money.
  const fresh = getOrderRow(deps, orderId)!;
  if (fresh.trapped === 1) throw new Error(`refusing to capture trapped order ${orderId}`);
  let captureId = alreadyCapturedId;
  if (!captureId) {
    try {
      const cap = await paypalForOrder(deps, orderId).captureOrder(orderId, `mirage-capture-${orderId}`);
      if (cap.status !== 'COMPLETED') throw new Error(`capture status ${cap.status}`);
      captureId = cap.captureId;
    } catch (e) {
      console.warn(`[checkout] capture failed for ${orderId}: ${(e as Error).message}`);
      throw new HttpError(502, "We couldn't complete the payment with PayPal. You have not been charged.",
        { orderId, status: 'AWAITING_APPROVAL', message: "We couldn't complete the payment with PayPal. You have not been charged." });
    }
  }
  db.prepare("UPDATE orders SET status = 'COMPLETED', capture_id = ? WHERE order_id = ?").run(captureId ?? null, orderId);
  return publicStatus(orderId, 'COMPLETED');
}

// ---------------------------------------------------------------- status + review

export function orderStatus(deps: PaypalLayerDeps, orderId: string): PublicOrderStatus {
  const row = getOrderRow(deps, orderId);
  if (!row) throw new HttpError(404, 'Unknown order');
  return publicStatus(orderId, row.status);
}

export function review(deps: PaypalLayerDeps, orderId: string, body: Partial<ReviewReq>): Promise<PublicOrderStatus> {
  return withOrderLock(orderId, async () => {
    if (body?.decision !== 'release' && body?.decision !== 'cancel') throw new HttpError(400, "decision must be 'release' or 'cancel'");
    const note = typeof body.note === 'string' ? body.note.slice(0, 500) : undefined;
    const db = deps.getDb();
    const row = getOrderRow(deps, orderId);
    if (!row) throw new HttpError(404, 'Unknown order');
    const decide = (detail: Record<string, unknown>) => deps.emit({
      storeId: row.store_id, sessionId: row.session_id, kind: 'REVIEW_DECISION', severity: 'info',
      detail: { decision: body.decision, note, orderId, ...detail },
    });

    if (body.decision === 'cancel') {
      if (row.status !== 'PENDING_REVIEW' && row.status !== 'AWAITING_APPROVAL') {
        throw new HttpError(409, 'Only pending orders can be cancelled', publicStatus(orderId, row.status));
      }
      // An uncaptured PayPal order simply expires; no money moved, nothing to void.
      db.prepare("UPDATE orders SET status = 'CANCELLED' WHERE order_id = ?").run(orderId);
      decide({ captured: false });
      return publicStatus(orderId, 'CANCELLED');
    }

    if (row.status !== 'PENDING_REVIEW') throw new HttpError(409, 'Only orders pending review can be released', publicStatus(orderId, row.status));
    // A human cleared it: it is no longer a trapped order, so it may be captured (within PayPal's approval window).
    db.prepare('UPDATE orders SET trapped = 0 WHERE order_id = ?').run(orderId);
    try {
      const cap = await paypalForOrder(deps, orderId).captureOrder(orderId, `mirage-capture-${orderId}`);
      if (cap.status !== 'COMPLETED') throw new Error(`capture status ${cap.status}`);
      db.prepare("UPDATE orders SET status = 'COMPLETED', capture_id = ? WHERE order_id = ?").run(cap.captureId ?? null, orderId);
    } catch (e) {
      db.prepare('UPDATE orders SET trapped = ? WHERE order_id = ?').run(row.trapped, orderId);
      decide({ captured: false, error: (e as Error).message });
      throw new HttpError(409, 'PayPal would not capture this order (the approval may have expired). It stays pending review; no money moved.', {
        orderId, status: 'PENDING_REVIEW',
        message: 'PayPal would not capture this order (the approval may have expired). It stays pending review; no money moved.',
      });
    }
    decide({ captured: true, previouslyTrapped: row.trapped === 1 });
    return publicStatus(orderId, 'COMPLETED');
  });
}
