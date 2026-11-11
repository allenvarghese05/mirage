// Real sandbox refunds for Workstream A: the honest policy path (policy.refundRequest approved and the
// past order has a paypal_capture_id) and the baseline store's manager_refund. Runs on the PayPal
// Agent Toolkit's create_refund, with a per-refund PayPal-Request-Id so retries can't refund twice.
// Wire with: registerRefundExecutor(paypalRefundExecutor) (see server/paypal/deps.ts).
import { getPaypalDeps } from './deps';
import { executeRefund } from './toolkit';

export interface RefundExecutorRequest {
  refundId: string; sessionId: string; orderRef?: string | null; amountCents: number; paypalCaptureId?: string | null;
}

/**
 * Matches A's registerRefundExecutor (server/mirage/policy.ts). Called for every approved honest refund
 * and baseline manager refund. No capture id → nothing to refund at PayPal (recorded only). Throws on
 * failure (A then leaves the refund executed=0); retries are safe because the PayPal-Request-Id is
 * derived from A's refund id.
 */
export async function paypalRefundExecutor(r: RefundExecutorRequest): Promise<{ paypalRefundId?: string }> {
  if (!r.paypalCaptureId) return {};
  const res = await executeRefund(getPaypalDeps().toolkit(), {
    captureId: r.paypalCaptureId,
    amountCents: r.amountCents,
    note: r.orderRef ? `Refund for order ${r.orderRef}` : undefined,
    requestId: `mirage-refund-${r.refundId}`,
  });
  if (res.status !== 'COMPLETED' && res.status !== 'PENDING') throw new Error(`PayPal refund status ${res.status}`);
  return { paypalRefundId: res.id };
}

export interface CaptureRefundResult { ok: boolean; refundId?: string; status?: string; error?: string }

export async function executeCaptureRefund(o: { captureId: string; amountCents?: number; note?: string; requestId?: string }): Promise<CaptureRefundResult> {
  try {
    const r = await executeRefund(getPaypalDeps().toolkit(), o);
    return { ok: r.status === 'COMPLETED' || r.status === 'PENDING', refundId: r.id, status: r.status };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
