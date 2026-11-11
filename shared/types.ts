// Shared types. This file is the CONTRACT between workstreams.
// Change it only in a dedicated commit, and say so in the PR description.

export type StoreId = 'northpeak' | 'driftwood';

/** 'mirage' = protected store. 'baseline' = comparison store with REAL secrets in the agent prompt and REAL privileged tools. */
export type StoreMode = 'mirage' | 'baseline';

/** 'shadow' = a trap has fired; privileged-sounding tools now return plausible "submitted for review" answers and do nothing. */
export type SessionMode = 'normal' | 'shadow';

export interface PublicProduct {
  id: string;
  storeId: StoreId;
  name: string;
  description: string;
  listPriceCents: number;
  imageUrl?: string;
}

/** Server-only. Never serialize to the browser or to the LLM in mirage mode. */
export interface ProductSecrets {
  productId: string;
  realFloorCents: number;
}

/** Server-only. One kit per chat session, generated when the session starts. */
export interface DecoyKit {
  sessionId: string;
  /** productId -> fake floor price in cents (looks plausible, below the real floor) */
  fakeFloorCents: Record<string, number>;
  /** Self-tracing HMAC code, e.g. STAFF-7Q2X-K9MD. Applying it at checkout trips the wire. */
  staffCode: string;
  /** Self-tracing HMAC code the agent believes authorises manager refunds. */
  refundOverrideCode: string;
  /** Names of honey tools offered to the agent for this session (all fake). */
  honeyTools: string[];
}

export type DecoyKind = 'staff_code' | 'refund_override' | 'fake_floor';

export type TripKind =
  | 'ATTACK_ATTEMPT'     // classifier flagged a manipulation attempt (no leak yet)
  | 'DECOY_LEAKED'       // agent output contained one of this session's decoys
  | 'HONEY_TOOL_CALLED'  // agent called a honey tool -> session switches to shadow
  | 'DECOY_REDEEMED'     // a decoy code / fake floor was used at checkout
  | 'IDENTITY_CAPTURED'  // PayPal payer identity read from an approved trapped order
  | 'NETWORK_MATCH'      // payer already on the shared block list (other store)
  | 'RISK_SIGNAL_SENT'   // risk-context (STC) call attempted; detail.ok tells result
  | 'ORDER_HELD'         // trapped order left uncaptured, status pending review
  | 'REVIEW_DECISION';   // human released or cancelled a held order

export type Severity = 'info' | 'warn' | 'high' | 'critical';

export interface TripEvent {
  id: string;
  at: string; // ISO
  storeId: StoreId;
  sessionId: string;
  kind: TripKind;
  severity: Severity;
  /** Free-form, but use these keys when relevant: decoyCode, decoyKind, sourceSessionId, toolName, technique, payerId, orderId, amountCents */
  detail: Record<string, unknown>;
}

export interface ChatMessage {
  id: string;
  sessionId: string;
  role: 'user' | 'assistant' | 'tool';
  content: string;
  toolName?: string;
  at: string;
}

export interface PayerIdentity {
  payerId: string;
  name?: string;
  email?: string;
  countryCode?: string;
  shippingAddress?: string;
}

/** What the BROWSER is allowed to see about an order. Never includes trapped/decoy info. */
export interface PublicOrderStatus {
  orderId: string;
  status: 'AWAITING_APPROVAL' | 'COMPLETED' | 'PENDING_REVIEW' | 'CANCELLED';
  message: string;
}

export type DetectionStage = 'none' | 'chat_attempt' | 'chat_leak' | 'honey_tool' | 'checkout' | 'identity';

export interface SimRun {
  id: string;
  batchId: string;
  storeMode: StoreMode;
  storeId: StoreId;
  persona: string;          // e.g. 'attacker.indirect_injection', 'honest.angry_refund'
  isAttack: boolean;
  technique: string;        // human label shown in the grid
  whiteBox: boolean;
  turns: number;
  leakedAnything: boolean;  // agent revealed a decoy (mirage) or a secret (baseline)
  realSecretLeaked: boolean;
  dollarsLostCents: number;
  detectedStage: DetectionStage;
  attributedCorrectly: boolean | null; // null when nothing was redeemed
  identityCaptured: boolean;
  falseAlarm: boolean;      // honest persona that tripped any wire
  honestOutcomeOk: boolean | null; // honest persona got what it legitimately needed
  sessionId: string;        // link to transcript
  createdAt: string;
}

export interface ScoreboardSummary {
  storeMode: StoreMode;
  attackRuns: number;
  honestRuns: number;
  leakRate: number;            // 0..1 over attack runs
  realSecretsLeaked: number;
  dollarsLostCents: number;
  attackersCaught: number;
  identitiesCaptured: number;
  attributionAccuracy: number | null; // 0..1
  falseAlarms: number;
  honestServedOk: number;
}
