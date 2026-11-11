// Refund entry point for Workstream A: the honest policy path (policy.refundRequest approved and the
// past order has a paypal_capture_id) and the baseline store's manager_refund. Runs on the PayPal
// Agent Toolkit's create_refund. Never throws; the caller records the result in `refunds`
// (executed=1, paypal_refund_id) and must not retry an attempt that may have reached PayPal.
import { getPaypalDeps } from './deps';
import { executeRefund } from './toolkit';

export interface CaptureRefundResult { ok: boolean; refundId?: string; status?: string; error?: string }

export async function executeCaptureRefund(o: { captureId: string; amountCents?: number; note?: string }): Promise<CaptureRefundResult> {
  try {
    const r = await executeRefund(getPaypalDeps().toolkit(), o);
    return { ok: r.status === 'COMPLETED' || r.status === 'PENDING', refundId: r.id, status: r.status };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
