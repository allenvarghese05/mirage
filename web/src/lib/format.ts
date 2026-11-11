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

/** Self-tracing decoy codes look like PREFIX-SEQ4-SIG4, e.g. NP-CREW-00A7-K9MD. */
export interface DecodedCode { code: string; prefix: string; seq: string; sig: string; chat: string }
export function decodeCode(code: string | undefined | null): DecodedCode | null {
  if (!code) return null;
  const m = code.trim().toUpperCase().match(/^(.*?)-([0-9A-Z]{4})-([0-9A-Z]{4})$/);
  if (!m) return null;
  const seq = m[2];
  const chat = seq.replace(/^0+(?=..)/, '') || seq;
  return { code: code.trim().toUpperCase(), prefix: m[1], seq, sig: m[3], chat: `#${chat}` };
}

/** Human chat label, e.g. "chat #A7". Uses the session's decoy code sequence when known. */
export function chatLabel(sessionId: string, decoyCode?: string | null): string {
  const d = decodeCode(decoyCode);
  if (d) return `chat ${d.chat}`;
  const tail = sessionId.replace(/[^0-9a-z]/gi, '').slice(-4).toUpperCase();
  return `chat #${tail}`;
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

const str = (v: unknown) => (typeof v === 'string' ? v : v == null ? '' : String(v));

/** One-line, plain-English headline for an event (used in feeds, toasts and the demo). */
export function eventHeadline(e: TripEvent): { title: string; sub: string } {
  const d = e.detail ?? {};
  const code = str(d.decoyCode);
  const label = chatLabel(str(d.sourceSessionId) || e.sessionId, code || undefined);
  switch (e.kind) {
    case 'ATTACK_ATTEMPT':
      return { title: `Attack attempt: ${str(d.technique) || 'manipulation'}`, sub: str(d.excerpt) || 'Logged. Nothing leaked.' };
    case 'DECOY_LEAKED':
      return {
        title: `Fake secret leaked from ${label}`,
        sub: `${str(d.decoyKind).replace('_', ' ') || 'decoy'}${code ? ` · ${code}` : ''} · real secrets leaked: 0`,
      };
    case 'HONEY_TOOL_CALLED':
      return { title: 'Fake tool used → chat switched to shadow mode', sub: `${str(d.toolName) || 'honey tool'}() is not a real tool. Calling it proves a hijack.` };
    case 'DECOY_REDEEMED':
      return { title: `Code traced: it came from ${label}`, sub: `${code || 'decoy'} applied at checkout${d.amountCents ? ` · ${moneyExact(Number(d.amountCents))}` : ''}` };
    case 'IDENTITY_CAPTURED':
      return { title: 'Identity captured via PayPal', sub: `payer ${str(d.payerId)}${d.name ? ` · ${str(d.name)}` : ''}` };
    case 'NETWORK_MATCH': {
      const store = STORE_SHORT[d.firstSeenStore as StoreId] ?? (str(d.firstSeenStore) || 'another store');
      return { title: `NETWORK MATCH: payer seen at ${store}`, sub: `payer ${str(d.payerId)} is on the shared block list` };
    }
    case 'RISK_SIGNAL_SENT':
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
  for (const e of events) {
    const c = e.detail?.decoyCode;
    if (typeof c === 'string' && decodeCode(c)) return c;
  }
  return undefined;
}
