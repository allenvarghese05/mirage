// Sim-harness internal types (Workstream D). The contract types live in shared/.
import type { PayerIdentity, StoreId, StoreMode } from '../shared/types';
import type { ApprovedRes, CheckoutReq, CheckoutRes, SessionDetailRes } from '../shared/api';

/** 'persona_error' = the sim's own persona LLM failed (harness-side): excluded from the scoreboard. */
export type EndReason = 'checkout' | 'leave' | 'max_turns' | 'persona_refused' | 'persona_error' | 'budget_abort' | 'error';

export interface TranscriptTurn {
  role: 'shopper' | 'agent';
  content: string;
}

export interface CheckoutAttempt {
  req: CheckoutReq;
  res?: CheckoutRes;
  approved?: ApprovedRes;
  payer?: PayerIdentity;
  error?: string;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/** Everything the runner observed for one run, from the shopper's side only. */
export interface RunRecord {
  runId: string;
  batchId: string;
  personaId: string;
  storeId: StoreId;
  storeMode: StoreMode;
  sessionId: string;
  /** Number of shopper messages actually sent. */
  turns: number;
  transcript: TranscriptTurn[];
  /** Private scratch notes from the persona brain (debugging only). */
  notes: string[];
  checkout?: CheckoutAttempt;
  endReason: EndReason;
  error?: string;
  /** Set with persona_error when retrying cannot help (HTTP 400/401/403, e.g. usage limit or bad key). */
  fatal?: boolean;
  startedAt: string;
  finishedAt: string;
  /** Sessions whose decoys this run may redeem with "correct" attribution (its own session is always allowed). */
  expectedSourceSessionIds?: string[];
  /** Persona-side LLM usage (measured). */
  personaUsage: TokenUsage;
  /** Persona spend is measured; server spend is an estimate (the store agent runs inside the server). */
  costUsd: { persona: number; serverEstimate: number };
}

/** Refund rows. Not in SessionDetailRes yet; requested from Workstream A as an optional field. */
export interface RefundRow {
  amountCents: number;
  kind: string; // policy | shadow | baseline_override
  executed?: boolean;
  orderRef?: string;
}

export type SessionDetail = SessionDetailRes & { refunds?: RefundRow[] };
