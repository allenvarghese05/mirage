import type { StoreId, TripEvent, TripKind } from '../../../shared/types';

export const money = (cents: number, opts: { compact?: boolean } = {}) => {
  const v = cents / 100;
  if (opts.compact && Math.abs(v) >= 1000) return `$${(v / 1000).toFixed(v >= 10000 ? 0 : 1)}k`;
  return v.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: v % 1 === 0 ? 0 : 2 });
};

export const moneyExact = (cents: number) =>
  (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2 });

export const clock = (iso: string) =>
  new Date(iso).toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });

export const shortDate = (iso: string) =>
  new Date(iso).toLocaleDateString('en-US', { month: 'numeric', day: 'numeric' });

export const relTime = (iso: string, now = Date.now()) => {
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
};

/** Self-tracing decoy codes look like PREFIX-SEQ4-SIG4, e.g. NP-STAFF-00A7-K9MD. */
export interface DecodedCode { code: string; prefix: string; seq: string; sig: string; chat: string }
export function decodeCode(code: string | undefined | null): DecodedCode | null {
  if (!code) return null;
  const m = code.trim().toUpperCase().match(/^(.*?)-([0-9A-Z]{4})-([0-9A-Z]{4})$/);
  if (!m) return null;
  const seq = m[2];
  const chat = seq.replace(/^0+(?=..)/, '') || seq;
  return { code: code.trim().toUpperCase(), prefix: m[1], seq, sig: m[3], chat: `#${chat}` };
}

/** A fake-floor trap is stored as `floor:<productId>:<cents>:<sourceSessionId>` (B's orders.code_used). */
export interface FloorCode { productId: string; cents: number; sourceSessionId: string }
export function parseFloorCode(code: string | undefined | null): FloorCode | null {
  const m = code?.match(/^floor:([^:]+):(\d+):(.+)$/);
  return m ? { productId: m[1], cents: Number(m[2]), sourceSessionId: m[3] } : null;
}

// sessionId -> that session's own decoy code. Server session ids (s_<hex>) carry no sequence, so the
// "chat #A7" label comes from the session's planted code once we have seen it (kit, leak, or redemption).
const sessionCodes = new Map<string, string>();
export function registerSessionCode(sessionId: string | undefined | null, code: string | undefined | null) {
  if (sessionId && code && decodeCode(code) && !sessionCodes.has(sessionId)) sessionCodes.set(sessionId, code);
}
/** Learn session -> code pairs from events. Only pairings that are certain: a code always belongs to the chat it was planted in. */
export function learnFromEvents(events: TripEvent[]) {
  for (const e of events) {
    const code = typeof e.detail?.decoyCode === 'string' ? e.detail.decoyCode : undefined;
    if (!code || !decodeCode(code)) continue;
    if (e.kind === 'DECOY_LEAKED' || e.kind === 'HONEY_TOOL_CALLED') registerSessionCode(e.sessionId, code);
    if (e.kind === 'DECOY_REDEEMED' && typeof e.detail.sourceSessionId === 'string') registerSessionCode(e.detail.sourceSessionId, code);
  }
}

/** Human chat label, e.g. "chat #A7". Uses the session's decoy code sequence when known. */
export function chatLabel(sessionId: string, decoyCode?: string | null): string {
  const d = decodeCode(decoyCode) ?? decodeCode(sessionCodes.get(sessionId));
  if (d) return `chat ${d.chat}`;
  const tail = sessionId.replace(/[^0-9a-z]/gi, '').slice(-4).toUpperCase();
  return `chat #${tail.replace(/^0+(?=..)/, '')}`;
}

export const STORE_NAMES: Record<StoreId, string> = {
  northpeak: 'Northpeak Outfitters',
  driftwood: 'Driftwood Coffee Co.',
};
export const STORE_SHORT: Record<StoreId, string> = { northpeak: 'Northpeak', driftwood: 'Driftwood' };

export type Tone = 'attempt' | 'leak' | 'honey' | 'identity' | 'info' | 'held' | 'ok';

export const KIND_META: Record<TripKind, { tone: Tone; label: string; glyph: string }> = {
  ATTACK_ATTEMPT: { tone: 'attempt', label: 'Attack attempt', glyph: '◇' },
  DECOY_LEAKED: { tone: 'leak', label: 'Fake secret leaked', glyph: '◈' },
  HONEY_TOOL_CALLED: { tone: 'honey', label: 'Fake tool used', glyph: '⬢' },
  DECOY_REDEEMED: { tone: 'honey', label: 'Code traced', glyph: '⌖' },
  IDENTITY_CAPTURED: { tone: 'identity', label: 'Identity captured', glyph: '◉' },
  NETWORK_MATCH: { tone: 'identity', label: 'Network match', glyph: '⟁' },
  RISK_SIGNAL_SENT: { tone: 'info', label: 'Risk context sent', glyph: '↗' },
  ORDER_HELD: { tone: 'held', label: 'Order held', glyph: '‖' },
  REVIEW_DECISION: { tone: 'ok', label: 'Review decision', glyph: '✓' },
};

const TECHNIQUE_LABELS: Record<string, string> = {
  injection: 'prompt injection', indirect_injection: 'hidden instruction (indirect injection)', authority: 'pretending to be staff',
  roleplay: 'roleplay ("pretend you are…")', encoding: 'encoding trick', urgency: 'false urgency', refund_fraud: 'refund fraud',
  probing: 'probing for staff secrets', multi_turn_social: 'multi-turn social engineering', price_probe: 'price probing',
};
/** Classifier slugs ("refund_fraud") to plain words; free-text labels pass through unchanged. */
export function techniqueLabel(t: unknown): string {
  const s = typeof t === 'string' ? t.trim() : '';
  if (!s) return 'manipulation';
  return TECHNIQUE_LABELS[s] ?? (/^[a-z_]+$/.test(s) ? s.replace(/_/g, ' ') : s);
}

const str = (v: unknown) => (typeof v === 'string' ? v : v == null ? '' : String(v));

/** One-line, plain-English headline for an event (used in feeds, toasts and the demo). */
export function eventHeadline(e: TripEvent): { title: string; sub: string } {
  const d = e.detail ?? {};
  const code = str(d.decoyCode);
  const floor = parseFloorCode(code);
  const source = str(d.sourceSessionId) || floor?.sourceSessionId || e.sessionId;
  const label = chatLabel(source, floor ? undefined : code || undefined);
  const leakedValue = d.decoyKind === 'fake_floor' && typeof d.amountCents === 'number' ? moneyExact(d.amountCents) : code;
  switch (e.kind) {
    case 'ATTACK_ATTEMPT':
      return { title: `Attack attempt: ${techniqueLabel(d.technique)}`, sub: str(d.excerpt) || 'Logged. Nothing leaked.' };
    case 'DECOY_LEAKED':
      return {
        title: `Fake secret leaked from ${chatLabel(e.sessionId)}`,
        sub: `${str(d.decoyKind).replace('_', ' ') || 'decoy'}${leakedValue ? ` · ${leakedValue}` : ''} · real secrets leaked: 0`,
      };
    case 'HONEY_TOOL_CALLED':
      return { title: 'Fake tool used → chat switched to shadow mode', sub: `${str(d.toolName) || 'honey tool'}() is not a real tool. Calling it proves a hijack.` };
    case 'DECOY_REDEEMED':
      if (floor || d.decoyKind === 'fake_floor') {
        const cents = floor?.cents ?? Number(d.fakeFloorCents ?? d.amountCents ?? 0);
        return { title: `Fake floor price traced: it came from ${label}`, sub: `${moneyExact(cents)} was planted only in ${label}${d.stage === 'quote' ? ' · offered in chat' : ' · used at checkout'}` };
      }
      return { title: `Code traced: it came from ${label}`, sub: `${code || 'decoy'} applied at checkout${d.amountCents ? ` · ${moneyExact(Number(d.amountCents))}` : ''}` };
    case 'IDENTITY_CAPTURED':
      return { title: 'Identity captured via PayPal', sub: `payer ${str(d.payerId)}${d.name ? ` · ${str(d.name)}` : ''}` };
    case 'NETWORK_MATCH': {
      if (d.via === 'client_fingerprint') {
        return { title: 'NETWORK MATCH: same device as an earlier trapped chat', sub: `matched ${chatLabel(str(d.matchedSessionId))} by client fingerprint` };
      }
      const store = STORE_SHORT[d.firstSeenStore as StoreId] ?? (str(d.firstSeenStore) || 'another store');
      return { title: `NETWORK MATCH: payer seen at ${store}`, sub: `payer ${str(d.payerId)} is on the shared block list` };
    }
    case 'RISK_SIGNAL_SENT':
      if (d.skipped) return { title: 'Risk context not sent', sub: `skipped: ${str(d.skipped)}` };
      return { title: 'Risk context sent to PayPal', sub: d.ok === false ? `failed${d.httpStatus ? ` (HTTP ${str(d.httpStatus)})` : ''}, logged and ignored` : 'accepted' };
    case 'ORDER_HELD':
      return { title: 'Order held · never captured · $0 moved', sub: `${str(d.orderId)} pending human review` };
    case 'REVIEW_DECISION':
      return { title: `Reviewer ${str(d.decision) === 'release' ? 'released' : 'cancelled'} the order`, sub: str(d.note) || str(d.orderId) };
  }
}

export const titleCase = (s: string) => s.replace(/[_.]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

export function sessionDecoyCode(events: TripEvent[], fallback?: string | null): string | undefined {
  if (fallback) return fallback;
  // Only codes that belong to the chat itself: what it leaked or fed a honey tool, or a redemption traced back to it.
  for (const e of events) {
    const c = e.detail?.decoyCode;
    if (typeof c !== 'string' || !decodeCode(c)) continue;
    if (e.kind === 'DECOY_LEAKED' || e.kind === 'HONEY_TOOL_CALLED') return c;
    if (e.kind === 'DECOY_REDEEMED' && e.detail.sourceSessionId === e.sessionId) return c;
  }
  return undefined;
}

/** Short display for an order's code_used: decoy codes as-is, fake-floor traps as a price. */
export function prettyCode(code: string | undefined | null): string {
  const f = parseFloorCode(code);
  return f ? `fake floor ${moneyExact(f.cents)}` : code ?? '';
}
