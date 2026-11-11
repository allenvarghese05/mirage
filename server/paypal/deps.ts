// The seam between Workstream B (PayPal layer) and Workstream A (core engine).
//
// B needs three things from A: the SQLite handle, traceCode() for self-tracing decoy codes, and the
// tripwire emit(). A builds them in parallel, so B codes against these thin interfaces. B reads and
// writes the contract tables in server/db/schema.sql directly (orders, blocklist, risk_payloads, and
// reads sessions/quotes), so it does not depend on the names of A's typed helpers.
//
// WIRING (orchestrator, after A merges) — either call setPaypalDeps() once at startup in server/app.ts:
//
//   import { getDb } from './db';
//   import { isTrappedQuote, traceCode } from './mirage/decoys';
//   import { emit } from './mirage/tripwire';
//   import { registerRefundExecutor } from './mirage/policy';
//   import { setPaypalDeps } from './paypal/deps';
//   import { paypalRefundExecutor } from './paypal/refunds';
//   setPaypalDeps({ getDb, traceCode, emit, isTrappedQuote });
//   registerRefundExecutor(paypalRefundExecutor);
//
// or replace the `notWired` defaults below with those imports.
import type { DatabaseSync } from 'node:sqlite';
import type { DecoyKind, TripEvent } from '../../shared/types';
import { config } from '../config';
import { readAdminToken } from './admin';
import { createPayPalClient, type PayPalApi } from './client';
import { createFakePayPal, type FakePayPal } from './fake';
import { createToolkitRunner, type ToolkitRunner } from './toolkit';

export const SIM_ORDER_PREFIX = 'SIM-';
export const isSimOrderId = (orderId: string | undefined | null): boolean => Boolean(orderId?.startsWith(SIM_ORDER_PREFIX));

export type EmitInput = Omit<TripEvent, 'id' | 'at'>;
export interface TraceResult { sessionId: string; kind: DecoyKind }

export interface PaypalLayerConfig {
  /** MIRAGE_SIM=1: sim sessions may use SIM- orders and simulatedPayer. */
  sim: boolean;
  merchantId: string;
  webhookId: string;
  publicBaseUrl: string;
  production: boolean;
  hasPaypalKeys: boolean;
  /** MIRAGE_ADMIN_TOKEN: lets a non-loopback merchant release held orders. Empty = loopback only. */
  adminToken: string;
}

export interface PaypalLayerDeps {
  getDb(): DatabaseSync;
  traceCode(code: string): TraceResult | null;
  emit(e: EmitInput): unknown;
  /** Non-null when the session's agreed quote for the product equals a planted fake floor. */
  isTrappedQuote(sessionId: string, productId: string): { sourceSessionId: string } | null;
  /** Real sandbox REST client. Throws if keys are missing or PAYPAL_BASE isn't the sandbox. */
  paypal(): PayPalApi;
  /** In-process PayPal for SIM- orders (sim mode only). */
  simPaypal(): FakePayPal;
  /** PayPal Agent Toolkit (get_order, create_refund, list_transactions). Throws if keys are missing. */
  toolkit(): ToolkitRunner;
  config: PaypalLayerConfig;
}

const notWired = (name: string) => () => {
  throw new Error(`paypal-layer: ${name} is not wired. Call setPaypalDeps({ getDb, traceCode, emit, isTrappedQuote }) at startup (see server/paypal/deps.ts).`);
};

let realClient: PayPalApi | null = null;
let simClient: FakePayPal | null = null;
let toolkitRunner: ToolkitRunner | null = null;

function defaults(): PaypalLayerDeps {
  return {
    getDb: notWired('getDb') as () => DatabaseSync,
    traceCode: notWired('traceCode') as (code: string) => TraceResult | null,
    emit: notWired('emit'),
    isTrappedQuote: notWired('isTrappedQuote') as (s: string, p: string) => { sourceSessionId: string } | null,
    paypal: () => (realClient ??= createPayPalClient({
      clientId: config.paypal.clientId, clientSecret: config.paypal.clientSecret, base: config.paypal.base,
    })),
    simPaypal: () => (simClient ??= createFakePayPal({ idPrefix: SIM_ORDER_PREFIX })),
    toolkit: () => (toolkitRunner ??= createToolkitRunner({
      clientId: config.paypal.clientId, clientSecret: config.paypal.clientSecret, base: config.paypal.base,
    })),
    config: {
      sim: config.sim,
      merchantId: config.paypal.merchantId,
      webhookId: config.paypal.webhookId,
      publicBaseUrl: config.publicBaseUrl,
      production: process.env.NODE_ENV === 'production',
      hasPaypalKeys: Boolean(config.paypal.clientId && config.paypal.clientSecret),
      adminToken: readAdminToken(),
    },
  };
}

let current: PaypalLayerDeps = defaults();

export function setPaypalDeps(partial: Partial<PaypalLayerDeps>): void {
  current = { ...current, ...partial, config: { ...current.config, ...(partial.config ?? {}) } };
}

export function getPaypalDeps(): PaypalLayerDeps {
  return current;
}

/** Tests only. */
export function resetPaypalDeps(): void {
  current = defaults();
}


/** SIM- orders live in the in-process sim PayPal; everything else is the real sandbox. */
export function paypalForOrder(deps: PaypalLayerDeps, orderId: string | undefined | null): PayPalApi {
  return isSimOrderId(orderId) ? deps.simPaypal() : deps.paypal();
}
