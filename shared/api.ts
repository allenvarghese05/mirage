// HTTP API contract. Server (workstreams A + B) implements it; web (C) and sim (D) call it.
// All bodies are JSON. All money is integer cents (USD).

import type {
  ChatMessage, PayerIdentity, PublicOrderStatus, PublicProduct, ScoreboardSummary,
  SimRun, StoreId, StoreMode, TripEvent, SessionMode, DecoyKit,
} from './types';

// ---------- Store-facing (what a shopper or attacker can call) ----------

// GET /api/stores/:storeId/products
export type ListProductsRes = { products: PublicProduct[] };

// POST /api/sessions
export type CreateSessionReq = { storeId: StoreId; storeMode?: StoreMode; simRunId?: string };
export type CreateSessionRes = { sessionId: string; greeting: string };

// POST /api/sessions/:sessionId/messages
export type SendMessageReq = { content: string };
export type SendMessageRes = { reply: string; messages: ChatMessage[] };
// Note: tool messages are NOT returned to the shopper; only user/assistant roles.

// POST /api/checkout
export type CheckoutReq = {
  sessionId: string;
  items: { productId: string; qty: number }[];
  code?: string;           // promo / staff code typed by the shopper
};
export type CheckoutRes = {
  orderId: string;         // PayPal order id
  approveUrl: string;      // PayPal approval link (also usable with the JS SDK by orderId)
  totalCents: number;
  discountLabel?: string;  // e.g. "Staff pricing (40% off)" (shown for decoys too, so attackers see success)
};

// POST /api/checkout/:orderId/approved   (called by the web app's onApprove, or by sim)
export type ApprovedReq = {
  sessionId: string;
  /** ONLY honoured when server runs with MIRAGE_SIM=1 and the order was created by a sim session. */
  simulatedPayer?: PayerIdentity;
};
export type ApprovedRes = PublicOrderStatus;

// GET /api/orders/:orderId/status
export type OrderStatusRes = PublicOrderStatus;

// POST /api/paypal/webhook  (PayPal -> us; signature verified when PAYPAL_WEBHOOK_ID is set)

// GET /api/config/public   (never secrets)
export type PublicConfigRes = { paypalClientId: string; stores: { id: StoreId; name: string; tagline: string; agentName: string }[] };

// ---------- Dashboard (merchant-facing; no auth in the hackathon build, bound to localhost/demo) ----------

// GET /api/dashboard/events?since=ISO
export type EventsRes = { events: TripEvent[] };

// GET /api/dashboard/stream   -> text/event-stream, each `data:` line is a JSON TripEvent

// GET /api/dashboard/sessions
export type SessionsRes = {
  sessions: {
    sessionId: string; storeId: StoreId; storeMode: StoreMode; mode: SessionMode;
    startedAt: string; messageCount: number; topSeverity: TripEvent['severity'] | null;
    payerId?: string; simRunId?: string;
  }[];
};

// GET /api/dashboard/sessions/:sessionId
export type SessionDetailRes = {
  sessionId: string; storeId: StoreId; storeMode: StoreMode; mode: SessionMode;
  messages: ChatMessage[];        // includes tool messages
  events: TripEvent[];
  decoys: DecoyKit | null;        // dashboard may show fakes; it is the merchant's own view
  identity: PayerIdentity | null;
  orders: { orderId: string; status: PublicOrderStatus['status']; totalCents: number; codeUsed?: string; trapped: boolean }[];
  playbook: { at: string; technique: string; excerpt: string }[];
  /** Refund records for this session (policy = honest path, shadow = honey/trapped, baseline_override = comparison store). */
  refunds?: { orderRef: string | null; amountCents: number; kind: 'policy' | 'shadow' | 'baseline_override'; executed: boolean; at: string }[];
};

// GET /api/dashboard/spread/:sessionId   -> who used decoys that leaked from this session
export type SpreadRes = {
  sourceSessionId: string;
  nodes: { sessionId: string; storeId: StoreId; payerId?: string; role: 'source' | 'downstream' }[];
  edges: { from: string; to: string; decoyCode: string }[];
};

// GET /api/dashboard/network
export type NetworkRes = {
  blocked: { payerId: string; firstSeenStore: StoreId; firstSessionId: string; reason: string; at: string; hits: number }[];
};

// POST /api/dashboard/review/:orderId
export type ReviewReq = { decision: 'release' | 'cancel'; note?: string };
export type ReviewRes = PublicOrderStatus;

// GET /api/dashboard/scoreboard?batchId=
export type ScoreboardRes = { batchId: string | null; runs: SimRun[]; summary: ScoreboardSummary[] };

// GET /api/dashboard/payers/:payerId/history   (PayPal Agent Toolkit list_transactions; shape owned by B)
// Best effort: on failure `transactions` is [] and `error` says why (e.g. keys missing, Transaction Search not enabled).
export type PayerHistoryRes = {
  payerId: string;
  source: 'paypal-agent-toolkit:list_transactions';
  transactions: { transactionId: string; date?: string; amountCents?: number; currency?: string; status?: string; eventCode?: string }[];
  error?: string;
};

// POST /api/dashboard/sim-runs
export type SimRunsReq = { runs: SimRun[] };

// GET /api/dashboard/risk-payloads   -> STC payloads we sent / would send to PayPal risk
export type RiskPayloadsRes = { payloads: { at: string; orderId?: string; sessionId: string; ok: boolean; httpStatus?: number; body: Record<string, unknown> }[] };
