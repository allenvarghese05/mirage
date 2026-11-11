// Tripwire bus: every detection goes through emit(). It persists the event, pushes it to live subscribers
// (the dashboard SSE stream), and optionally posts one line to Discord.
import { randomUUID } from 'node:crypto';
import { config } from '../config';
import { insertEvent } from '../db';
import type { Severity, TripEvent, TripKind } from '../../shared/types';

export const DEFAULT_SEVERITY: Record<TripKind, Severity> = {
  ATTACK_ATTEMPT: 'warn',
  DECOY_LEAKED: 'high',
  HONEY_TOOL_CALLED: 'critical',
  DECOY_REDEEMED: 'critical',
  IDENTITY_CAPTURED: 'critical',
  NETWORK_MATCH: 'critical',
  RISK_SIGNAL_SENT: 'info',
  ORDER_HELD: 'high',
  REVIEW_DECISION: 'info',
};

export type EmitInput = Omit<TripEvent, 'id' | 'at' | 'severity'> & { severity?: Severity; at?: string };
type Listener = (e: TripEvent) => void;

const listeners = new Set<Listener>();

export function subscribe(fn: Listener): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

export function emit(input: EmitInput): TripEvent {
  const event: TripEvent = {
    id: `ev_${randomUUID()}`,
    at: input.at ?? new Date().toISOString(),
    storeId: input.storeId,
    sessionId: input.sessionId,
    kind: input.kind,
    severity: input.severity ?? DEFAULT_SEVERITY[input.kind],
    detail: input.detail ?? {},
  };
  insertEvent(event);
  for (const fn of listeners) {
    try { fn(event); } catch (err) { console.error('[tripwire] subscriber failed:', (err as Error).message); }
  }
  void postDiscord(event);
  return event;
}

const EMOJI: Record<Severity, string> = { info: '🔵', warn: '🟡', high: '🟠', critical: '🔴' };
const KEY_DETAILS = ['decoyCode', 'toolName', 'technique', 'payerId', 'orderId', 'sourceSessionId', 'amountCents'];

export function formatDiscordLine(e: TripEvent): string {
  const emoji = e.kind === 'IDENTITY_CAPTURED' ? '🟣' : EMOJI[e.severity];
  const key = KEY_DETAILS.find((k) => e.detail[k] !== undefined && e.detail[k] !== null);
  const detail = key ? ` · ${key}=${String(e.detail[key])}` : '';
  return `${emoji} [${e.storeId}] ${e.kind} · session ${e.sessionId}${detail}`.replace(/\s*\n\s*/g, ' ');
}

async function postDiscord(e: TripEvent): Promise<void> {
  if (!config.discordWebhook || process.env.VITEST) return;
  try {
    await fetch(config.discordWebhook, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: formatDiscordLine(e) }),
    });
  } catch (err) {
    console.warn('[tripwire] discord post failed:', (err as Error).message);
  }
}
