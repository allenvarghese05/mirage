// Best-effort risk signal to PayPal's Set Transaction Context (STC) API.
// PUT /v1/risk/transaction-contexts/{merchantId}/{clientMetadataId}
// The sandbox app may not be onboarded for STC, so failure is expected and fine: every attempt is
// recorded in risk_payloads (the dashboard shows "what we sent PayPal Risk"), RISK_SIGNAL_SENT is
// emitted with ok true/false, and this function NEVER throws.
import { randomUUID } from 'node:crypto';
import type { StoreId } from '../../shared/types';
import { paypalForOrder, type PaypalLayerDeps } from './deps';

export interface RiskSignalInput {
  storeId: StoreId;
  sessionId: string;
  orderId?: string;
  clientMetadataId: string;
  /** DecoyKind or 'network'. */
  trapKind: string;
  sourceSessionId?: string;
  payerId?: string;
}

export interface RiskSignalResult { ok: boolean; httpStatus?: number }

const RISK_TIMEOUT_MS = 4000;

function safely(fn: () => void): void {
  try { fn(); } catch (e) { console.warn('[risk] bookkeeping failed:', (e as Error).message); }
}

export function buildRiskPayload(i: RiskSignalInput) {
  const additional_data: { key: string; value: string }[] = [];
  if (i.payerId) additional_data.push({ key: 'sender_account_id', value: i.payerId });
  additional_data.push({ key: 'highrisk_txn_flag', value: '1' });
  additional_data.push({ key: 'mirage_trap_kind', value: i.trapKind });
  if (i.sourceSessionId) additional_data.push({ key: 'mirage_source_session', value: i.sourceSessionId });
  return { additional_data };
}

export async function sendRiskSignal(deps: PaypalLayerDeps, i: RiskSignalInput): Promise<RiskSignalResult> {
  const body = buildRiskPayload(i);
  let result: RiskSignalResult = { ok: false };
  let skipped: string | undefined;
  let error: string | undefined;

  if (!deps.config.merchantId) {
    skipped = 'no PAYPAL_MERCHANT_ID';
  } else {
    try {
      const pp = paypalForOrder(deps, i.orderId);
      const r = await Promise.race([
        pp.putRiskContext(deps.config.merchantId, i.clientMetadataId, body),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error('risk call timed out')), RISK_TIMEOUT_MS).unref?.()),
      ]);
      result = { ok: r.ok, httpStatus: r.status };
    } catch (e) {
      error = (e as Error).message;
    }
  }

  safely(() => {
    deps.getDb().prepare(
      'INSERT INTO risk_payloads (id, at, session_id, order_id, ok, http_status, body_json) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(randomUUID(), new Date().toISOString(), i.sessionId, i.orderId ?? null, result.ok ? 1 : 0, result.httpStatus ?? null, JSON.stringify(body));
  });
  safely(() => {
    deps.emit({
      storeId: i.storeId, sessionId: i.sessionId, kind: 'RISK_SIGNAL_SENT', severity: 'info',
      detail: { ok: result.ok, httpStatus: result.httpStatus, orderId: i.orderId, payerId: i.payerId, trapKind: i.trapKind, ...(skipped ? { skipped } : {}), ...(error ? { error } : {}) },
    });
  });
  return result;
}
