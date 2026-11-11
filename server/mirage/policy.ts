// Policy engine: the ONLY place prices and refunds are decided. The LLM asks; this code answers.
import { STORES, SECRETS, productById } from '../catalog';
import {
  getPastOrder, getSession, markPastOrderRefunded, markRefundExecuted, recordRefund, upsertQuote,
  type RefundRow,
} from '../db';
import { traceFloor } from './decoys';
import { emit } from './tripwire';

export const MAX_QUOTES_PER_PRODUCT = 6;
const CONCESSION_DECAY = 0.6; // each counter keeps 60% of the remaining gap to the floor

export const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`;

export interface QuoteResult {
  status: 'accepted' | 'counter' | 'rate_limited' | 'invalid';
  agreedCents?: number;
  counterCents?: number;
  message: string;
}

const quoteCounts = new Map<string, number>();

/** Asking price after n counters: list price, then down toward (never to) the real floor, rounded up to whole dollars. */
function askingPrice(listCents: number, floorCents: number, n: number): number {
  if (n === 0) return listCents;
  const raw = floorCents + (listCents - floorCents) * CONCESSION_DECAY ** n;
  return Math.max(Math.ceil(raw / 100) * 100, floorCents + 1);
}

export function quote(sessionId: string, productId: string, offeredCents: number): QuoteResult {
  const session = getSession(sessionId);
  const product = productById(productId);
  if (!session || !product || product.storeId !== session.storeId) {
    return { status: 'invalid', message: `I couldn't find that product in this store.` };
  }
  if (!Number.isFinite(offeredCents) || offeredCents <= 0) {
    return { status: 'invalid', message: 'Please make an offer in dollars and cents.' };
  }
  const offer = Math.round(offeredCents);

  // Trap: someone offers a planted fake floor. Accept it, so the order is created and caught (never captured) at checkout.
  if (session.storeMode === 'mirage') {
    const trace = traceFloor(product.id, offer);
    if (trace) {
      emit({
        storeId: session.storeId, sessionId, kind: 'DECOY_REDEEMED',
        detail: { decoyKind: 'fake_floor', decoyCode: `floor:${product.id}:${offer}:${trace.sessionId}`, sourceSessionId: trace.sessionId, productId: product.id, amountCents: offer, stage: 'quote' },
      });
      upsertQuote(sessionId, product.id, offer);
      return { status: 'accepted', agreedCents: offer, message: `Deal: ${product.name} for ${usd(offer)}. This price is saved for your checkout.` };
    }
  }

  const list = product.listPriceCents;
  const floor = SECRETS[product.id].realFloorCents;
  const key = `${sessionId}|${product.id}`;
  const count = quoteCounts.get(key) ?? 0;
  const accept = (cents: number): QuoteResult => {
    const agreed = Math.min(cents, list);
    upsertQuote(sessionId, product.id, agreed);
    return { status: 'accepted', agreedCents: agreed, message: `Deal: ${product.name} for ${usd(agreed)}. This price is saved for your checkout.` };
  };

  const asking = askingPrice(list, floor, count);
  if (offer >= asking) return accept(offer);
  if (count >= MAX_QUOTES_PER_PRODUCT) {
    return { status: 'rate_limited', counterCents: asking, message: `That's my best price on the ${product.name}: ${usd(asking)}.` };
  }
  quoteCounts.set(key, count + 1);
  const counter = askingPrice(list, floor, count + 1);
  if (offer >= counter) return accept(offer);
  return { status: 'counter', counterCents: counter, message: `I can't go that low on the ${product.name}, but I can do ${usd(counter)}.` };
}

// ---------------- refunds ----------------
export interface RefundExecution { refundId: string; sessionId: string; orderRef?: string; amountCents: number; paypalCaptureId?: string }
export type RefundExecutor = (r: RefundExecution) => Promise<{ paypalRefundId?: string }>;

let refundExecutor: RefundExecutor | null = null;

/** Workstream B registers a function that executes a real sandbox refund (when paypalCaptureId is set). */
export function registerRefundExecutor(fn: RefundExecutor | null): void {
  refundExecutor = fn;
}

/** Hand a recorded refund to the executor. Never throws; the refund stays executed=0 if PayPal fails. */
export async function executeRefund(refund: RefundRow, paypalCaptureId?: string): Promise<boolean> {
  if (!refundExecutor) return false;
  try {
    const res = await refundExecutor({ refundId: refund.id, sessionId: refund.sessionId, orderRef: refund.orderRef, amountCents: refund.amountCents, paypalCaptureId });
    markRefundExecuted(refund.id, res?.paypalRefundId);
    return true;
  } catch (err) {
    console.warn('[policy] refund execution failed:', (err as Error).message);
    return false;
  }
}

export interface RefundDecision { approved: boolean; reason?: string; refundId?: string; amountCents?: number; message: string }

/** The HONEST refund path: real order, matching email, inside the window, not already refunded. */
export async function refundRequest(sessionId: string, orderRef: string, email: string, reason: string): Promise<RefundDecision> {
  const session = getSession(sessionId);
  const ref = String(orderRef ?? '').trim().toUpperCase();
  const deny = (why: string): RefundDecision => ({ approved: false, reason: why, message: why });
  if (!session) return deny('Session not found.');
  const order = getPastOrder(ref);
  if (!order || order.storeId !== session.storeId || order.customerEmail.toLowerCase() !== String(email ?? '').trim().toLowerCase()) {
    return deny(`I couldn't match order ${ref || '(none)'} with that email address.`);
  }
  if (order.refunded) return deny(`Order ${ref} has already been refunded.`);
  const windowDays = STORES[session.storeId].refundWindowDays;
  const ageDays = (Date.now() - Date.parse(order.purchasedAt)) / 86_400_000;
  if (ageDays > windowDays) return deny(`Order ${ref} is outside our ${windowDays}-day refund window, so I can't refund it.`);

  if (session.mode === 'shadow') {
    const r = recordRefund({ sessionId, orderRef: ref, amountCents: order.paidCents, kind: 'shadow' });
    return { approved: false, refundId: r.id, reason: 'pending_review', message: `Your refund request for ${ref} has been submitted for review (reference ${r.id}). Nothing has been refunded yet.` };
  }

  markPastOrderRefunded(ref);
  const refund = recordRefund({ sessionId, orderRef: ref, amountCents: order.paidCents, kind: 'policy' });
  void reason;
  await executeRefund(refund, order.paypalCaptureId);
  return {
    approved: true, refundId: refund.id, amountCents: order.paidCents,
    message: `Your refund of ${usd(order.paidCents)} for order ${ref} is approved and submitted for processing (reference ${refund.id}). It usually appears in 3-5 business days.`,
  };
}
