import { useEffect, useState } from 'react';
import { api, type PayerHistory } from '../api/client';
import type { SessionDetailRes, NetworkRes, RiskPayloadsRes, SpreadRes } from '../../../shared/api';
import type { DecoyKit, PayerIdentity, StoreId, TripEvent } from '../../../shared/types';
import { kindMeta, STORE_SHORT, chatLabel, clock, decodeCode, eventHeadline, moneyExact, parseFloorCode, prettyCode, relTime, shortDate, techniqueLabel } from '../lib/format';

export const PRODUCT_NAMES: Record<string, string> = {
  'np-jacket': 'Ridgeline Insulated Jacket', 'np-boots': 'Switchback Hiking Boots', 'np-tent': 'Cirrus 2-Person Tent',
  'np-beanie': 'Merino Watch Cap', 'dw-grinder': 'Burr Hand Grinder', 'dw-kettle': 'Gooseneck Kettle', 'dw-beans': 'Single-Origin Beans (1 lb)',
};

export function Panel({ title, kicker, children, className = '', right }: {
  title: string; kicker?: string; children: React.ReactNode; className?: string; right?: React.ReactNode;
}) {
  return (
    <section className={`c-panel ${className}`}>
      <header className="c-panel-head">
        <div>
          <h3>{title}</h3>
          {kicker && <span className="c-kicker">{kicker}</span>}
        </div>
        {right}
      </header>
      <div className="c-panel-body">{children}</div>
    </section>
  );
}

// ------------------------------------------------------------ the trace (attempt > leak > redeemed > identified > held)
export function Trace({ detail }: { detail: SessionDetailRes }) {
  const ev = detail.events;
  const first = (k: string, pred: (e: TripEvent) => boolean = () => true) => ev.find((e) => e.kind === k && pred(e));
  if (detail.storeMode === 'baseline') {
    const lost = detail.orders.filter((o) => o.codeUsed && o.status === 'COMPLETED');
    return (
      <p className="trace-note">
        <span className="c-badge mode-baseline">Comparison store</span>
        <span>This agent holds the <b>real</b> codes and working staff tools. There is no trap and nothing to trace{lost.length ? <>: {lost.length} order{lost.length > 1 ? 's' : ''} went through at a staff discount.</> : '.'}</span>
      </p>
    );
  }
  const attempt = first('ATTACK_ATTEMPT');
  const leak = first('DECOY_LEAKED') ?? first('HONEY_TOOL_CALLED');
  const redeemed = first('DECOY_REDEEMED', (e) => Boolean(e.detail?.orderId)) ?? first('DECOY_REDEEMED');
  const identified = first('IDENTITY_CAPTURED') ?? first('NETWORK_MATCH');
  const held = first('ORDER_HELD');
  if (!attempt && !leak && !redeemed) {
    return <p className="trace-note"><span className="c-badge">Quiet</span><span>No attack in this chat. Nothing was flagged.</span></p>;
  }
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  const leakCode = str(leak?.detail?.decoyCode) || str(leak?.detail?.toolName);
  const heldOrder = detail.orders.find((o) => o.trapped);
  const steps: { tone: string; label: string; done: boolean; sub: string; mono?: boolean }[] = [
    { tone: 'attempt', label: 'Attack attempt', done: Boolean(attempt), sub: attempt ? techniqueLabel(attempt.detail?.technique) : 'None yet' },
    { tone: 'leak', label: 'Fake secret handed out', done: Boolean(leak), sub: leak ? (leakCode ? prettyCode(leakCode) : 'decoy') : 'Agent gave nothing away', mono: Boolean(leakCode) },
    { tone: 'honey', label: 'Used at PayPal checkout', done: Boolean(redeemed), sub: redeemed ? `Traced to ${chatLabel(str(redeemed.detail?.sourceSessionId) || detail.sessionId)}` : 'Not used yet' },
    { tone: 'identity', label: 'Identified by PayPal', done: Boolean(identified || detail.identity), sub: detail.identity?.name ?? (identified ? 'Payer on file' : 'After checkout approval') },
    { tone: 'held', label: 'Held, $0 charged', done: Boolean(held), sub: held ? (heldOrder ? `${moneyExact(heldOrder.totalCents)} never captured` : 'Never captured') : 'Nothing to hold' },
  ];
  return (
    <div className="trace" role="list" aria-label="What happened in this chat">
      {steps.map((s, i) => (
        <div key={s.label} role="listitem" className={`trace-step tone-${s.tone}${s.done ? ' is-done' : ''}`} style={{ '--i': i } as React.CSSProperties}>
          <div className="trace-rail"><span className="trace-dot" aria-hidden="true" /></div>
          <span className="trace-label">{s.label}<span className="sr-only">{s.done ? ' (done)' : ' (not reached)'}</span></span>
          <span className={`trace-sub${s.mono ? ' mono' : ''}`}>{s.sub}</span>
        </div>
      ))}
    </div>
  );
}

// ------------------------------------------------------------ alarm feed
export function AlarmRow({ e, selected, onSelect, fresh }: { e: TripEvent; selected?: boolean; onSelect?: (id: string) => void; fresh?: boolean }) {
  const meta = kindMeta(e.kind);
  const h = eventHeadline(e);
  return (
    <li>
      <button
        type="button"
        className={`alarm tone-${meta.tone}${selected ? ' is-selected' : ''}${fresh ? ' is-fresh' : ''}`}
        onClick={() => onSelect?.(e.sessionId)}
      >
        <span className="alarm-glyph" aria-hidden="true">{meta.glyph}</span>
        <span className="alarm-main">
          <span className="alarm-meta">
            <span className="alarm-kind">{meta.label}</span>
            <span>{STORE_SHORT[e.storeId]}</span>
            <span>{chatLabel(e.sessionId)}</span>
            <time dateTime={e.at}>{clock(e.at)}</time>
          </span>
          <span className="alarm-title">{h.title}</span>
          <span className="alarm-sub">{h.sub}</span>
        </span>
      </button>
    </li>
  );
}

export function AlarmFeed({ events, selectedSession, onSelect, freshIds }: {
  events: TripEvent[]; selectedSession?: string | null; onSelect?: (id: string) => void; freshIds?: Set<string>;
}) {
  const sorted = [...events].sort((a, b) => b.at.localeCompare(a.at));
  if (!sorted.length) return <p className="c-empty">No alarms yet. Quiet is good.</p>;
  return (
    <ul className="alarm-list">
      {sorted.map((e) => (
        <AlarmRow key={e.id} e={e} selected={e.sessionId === selectedSession} onSelect={onSelect} fresh={freshIds?.has(e.id)} />
      ))}
    </ul>
  );
}

// ------------------------------------------------------------ transcript
type Item = { at: string; kind: 'msg'; m: SessionDetailRes['messages'][number] } | { at: string; kind: 'evt'; e: TripEvent };

export function Transcript({ detail, maxEvents = true }: { detail: Pick<SessionDetailRes, 'messages' | 'events'>; maxEvents?: boolean }) {
  const items: Item[] = [
    ...detail.messages.map((m) => ({ at: m.at, kind: 'msg' as const, m })),
    ...(maxEvents ? detail.events.map((e) => ({ at: e.at, kind: 'evt' as const, e })) : []),
  ].sort((a, b) => a.at.localeCompare(b.at));
  return (
    <ol className="transcript">
      {items.map((it) => {
        if (it.kind === 'evt') {
          const meta = kindMeta(it.e.kind);
          return (
            <li key={it.e.id} className={`tx-event tone-${meta.tone}`}>
              <span aria-hidden="true">{meta.glyph}</span> {eventHeadline(it.e).title}
              <time>{clock(it.e.at)}</time>
            </li>
          );
        }
        const m = it.m;
        if (m.role === 'tool') {
          return (
            <li key={m.id} className="tx-tool">
              <span className="tx-tool-name">⚙ {m.toolName ?? 'tool'}()</span>
              <code>{m.content}</code>
            </li>
          );
        }
        return (
          <li key={m.id} className={`tx-msg tx-${m.role}`}>
            <span className="tx-who">{m.role === 'user' ? 'visitor' : 'agent'}<time>{clock(m.at)}</time></span>
            <p>{m.content}</p>
          </li>
        );
      })}
    </ol>
  );
}

// ------------------------------------------------------------ playbook
export function Playbook({ playbook, events }: { playbook: SessionDetailRes['playbook']; events: TripEvent[] }) {
  const items = playbook.length
    ? playbook.map((p) => ({ at: p.at, title: techniqueLabel(p.technique), sub: p.excerpt, tone: /redeem|checkout/i.test(p.technique) ? 'honey' : /tool/i.test(p.technique) ? 'honey' : 'attempt' }))
    : events.filter((e) => e.kind === 'ATTACK_ATTEMPT').map((e) => ({ at: e.at, title: techniqueLabel(e.detail.technique), sub: String(e.detail.excerpt ?? ''), tone: 'attempt' }));
  if (!items.length) return <p className="c-empty">No manipulation techniques seen in this chat.</p>;
  return (
    <ol className="playbook">
      {items.map((p, i) => (
        <li key={i} className={`tone-${p.tone}`}>
          <span className="pb-step">{String(i + 1).padStart(2, '0')}</span>
          <div>
            <b>{p.title}</b>
            <p>{p.sub}</p>
          </div>
          <time>{clock(p.at)}</time>
        </li>
      ))}
    </ol>
  );
}

// ------------------------------------------------------------ decoy kit
export function DecoyKitView({ kit, storeId, label }: { kit: DecoyKit | null; storeId: StoreId; label?: string }) {
  if (!kit) return <p className="c-empty">Baseline store: no decoys planted. This agent holds the real secrets.</p>;
  return (
    <div className="decoy-kit">
      <p className="decoy-lede">Planted for <b>{label ?? chatLabel(kit.sessionId, kit.staffCode)}</b> before the first message. Every value below is fake.</p>
      <dl className="decoy-grid">
        <div><dt>Staff code</dt><dd className="mono glow">{kit.staffCode}</dd></div>
        <div><dt>Refund override</dt><dd className="mono">{kit.refundOverrideCode}</dd></div>
      </dl>
      <table className="decoy-floors">
        <thead><tr><th>Fake floor price</th><th /></tr></thead>
        <tbody>
          {Object.entries(kit.fakeFloorCents).map(([pid, c]) => (
            <tr key={pid}><td>{PRODUCT_NAMES[pid] ?? pid}</td><td className="mono">{moneyExact(c)}</td></tr>
          ))}
        </tbody>
      </table>
      <div className="honey-tools">
        <span className="c-kicker">Honey tools</span>
        {kit.honeyTools.map((t) => <code key={t}>{t}()</code>)}
      </div>
      <p className="decoy-foot">Real floor prices and codes live only in server code. {storeId === 'northpeak' ? 'Northpeak' : 'Driftwood'}'s agent never sees them.</p>
    </div>
  );
}

// ------------------------------------------------------------ code decode
export function CodeDecode({ code, sourceSessionId, valid = true, animate = true }: { code: string; sourceSessionId?: string; valid?: boolean; animate?: boolean }) {
  const d = decodeCode(code);
  const [step, setStep] = useState(animate ? 0 : 3);
  useEffect(() => {
    if (!animate) return;
    setStep(0);
    const ts = [setTimeout(() => setStep(1), 350), setTimeout(() => setStep(2), 900), setTimeout(() => setStep(3), 1500)];
    return () => ts.forEach(clearTimeout);
  }, [code, animate]);
  if (!d) return <p className="c-empty">Code {code} could not be decoded.</p>;
  return (
    <div className="decode" data-step={step}>
      <div className="decode-code mono">
        <span className="dc-prefix">{d.prefix}-</span>
        <span className="dc-seq">{d.seq}</span>
        <span className="dc-dash">-</span>
        <span className="dc-sig">{d.sig}</span>
      </div>
      <div className="decode-line mono">
        <span className="dc-seq-chip">{d.seq}</span>
        <span className="dc-arrow">→</span>
        <span className="dc-chat">chat {d.chat}</span>
        <span className={`dc-sig-ok ${valid ? 'ok' : 'bad'}`}>{valid ? '✓ signature valid' : '✗ forged'}</span>
      </div>
      <p className="decode-note">
        Sequence <b>{d.seq}</b> names the chat it was planted in{sourceSessionId ? <> (<span className="mono">{sourceSessionId}</span>)</> : null}. The <b>{d.sig}</b> HMAC
        proves we issued it, so it cannot be guessed or forged.
      </p>
    </div>
  );
}

// ------------------------------------------------------------ fake-floor trace
/** Like CodeDecode, for a planted fake floor price: each chat gets its own odd-cents price, so the price names the chat. */
export function FloorTrace({ code, cents, sourceSessionId, productId }: { code?: string; cents?: number; sourceSessionId?: string; productId?: string }) {
  const f = parseFloorCode(code);
  const price = f?.cents ?? cents;
  const source = f?.sourceSessionId ?? sourceSessionId;
  const pid = f?.productId ?? productId;
  if (price === undefined || !source) return <p className="c-empty">Fake floor price could not be traced.</p>;
  return (
    <div className="decode" data-step={3}>
      <div className="decode-code mono"><span className="dc-seq">{moneyExact(price)}</span>{pid && <span className="dc-prefix">&nbsp;· {PRODUCT_NAMES[pid] ?? pid}</span>}</div>
      <div className="decode-line mono">
        <span className="dc-seq-chip">{moneyExact(price)}</span>
        <span className="dc-arrow">→</span>
        <span className="dc-chat">{chatLabel(source)}</span>
        <span className="dc-sig-ok ok">✓ planted only there</span>
      </div>
      <p className="decode-note">
        Every chat gets its own fake floor price, unique among active chats and always below the real floor.
        Anyone paying exactly <b>{moneyExact(price)}</b> learned it from <span className="mono">{source}</span>.
      </p>
    </div>
  );
}

/** Picks the right trace panel for a DECOY_REDEEMED event. */
export function RedemptionTrace({ e }: { e: TripEvent }) {
  const code = typeof e.detail.decoyCode === 'string' ? e.detail.decoyCode : undefined;
  const source = typeof e.detail.sourceSessionId === 'string' ? e.detail.sourceSessionId : undefined;
  if (e.detail.decoyKind === 'fake_floor' || parseFloorCode(code)) {
    return <FloorTrace code={code} cents={Number(e.detail.fakeFloorCents ?? e.detail.amountCents) || undefined} sourceSessionId={source} productId={e.detail.productId as string | undefined} />;
  }
  return code ? <CodeDecode code={code} sourceSessionId={source} valid={e.detail.signatureValid !== false} /> : <p className="c-empty">No code on this redemption.</p>;
}

// ------------------------------------------------------------ identity
export function IdentityCard({ identity, storeId, network, showHistory }: { identity: PayerIdentity | null; storeId?: StoreId; network?: boolean; showHistory?: boolean }) {
  if (!identity) return <p className="c-empty">No PayPal identity yet. It appears when a trapped order is approved.</p>;
  const initials = (identity.name ?? identity.payerId).split(/\s+/).map((w) => w[0]).slice(0, 2).join('');
  return (
    <div className="identity">
      <div className="id-top">
        <span className="id-avatar">{initials}</span>
        <div>
          <span className="c-kicker">PayPal payer{storeId ? ` · via ${STORE_SHORT[storeId]}` : ''}</span>
          <b className="id-name">{identity.name ?? 'Unknown name'}</b>
        </div>
        {network && <span className="id-flag">On block list</span>}
      </div>
      <dl className="id-fields">
        <div><dt>Payer ID</dt><dd className="mono">{identity.payerId}</dd></div>
        <div><dt>Email</dt><dd className="mono">{identity.email ?? '—'}</dd></div>
        <div><dt>Country</dt><dd>{identity.countryCode ?? '—'}</dd></div>
        <div><dt>Ship to</dt><dd>{identity.shippingAddress ?? '—'}</dd></div>
      </dl>
      {showHistory && <PayerHistoryView payerId={identity.payerId} />}
    </div>
  );
}

/** "PayPal history": this merchant's past transactions with the payer (B, Agent Toolkit list_transactions). Best effort. */
function PayerHistoryView({ payerId }: { payerId: string }) {
  const [h, setH] = useState<PayerHistory | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    setH(null); setFailed(false);
    api.payerHistory(payerId).then((r) => live && setH(r)).catch(() => live && setFailed(true));
    return () => { live = false; };
  }, [payerId]);
  return (
    <div className="id-history">
      <span className="c-kicker">PayPal history · last 31 days with this store</span>
      {failed || h?.error ? <p className="c-empty">PayPal history unavailable right now.</p>
        : !h ? <p className="c-empty">Asking PayPal…</p>
        : !h.transactions.length ? <p className="c-empty">No earlier transactions with this payer.</p>
        : (
          <ul>
            {h.transactions.slice(0, 5).map((t) => (
              <li key={t.transactionId}>
                <span className="mono">{t.date ? shortDate(t.date) : '—'}</span>
                <span className="mono">{t.amountCents !== undefined ? moneyExact(t.amountCents) : '—'}</span>
                <span className="mono c-dimtxt">{t.eventCode ?? ''} {t.status ?? ''}</span>
              </li>
            ))}
          </ul>
        )}
    </div>
  );
}

// ------------------------------------------------------------ orders
export function OrdersView({ orders, onReview, busy }: {
  orders: SessionDetailRes['orders']; onReview?: (orderId: string, d: 'release' | 'cancel') => void; busy?: string | null;
}) {
  if (!orders.length) return <p className="c-empty">No checkout from this chat.</p>;
  return (
    <ul className="orders">
      {orders.map((o) => (
        <li key={o.orderId} className={o.trapped ? 'is-trapped' : ''}>
          <div className="ord-top">
            <span className="mono">{o.orderId}</span>
            <span className={`ord-status st-${o.status.toLowerCase()}`}>{o.status.replace('_', ' ')}</span>
          </div>
          <div className="ord-mid">
            <span className="ord-amt">{moneyExact(o.totalCents)}</span>
            {o.codeUsed && <span className="mono ord-code" title={o.codeUsed}>{prettyCode(o.codeUsed)}</span>}
            {o.trapped && <span className="ord-trap">trapped · never captured · $0 moved</span>}
          </div>
          {o.status === 'PENDING_REVIEW' && onReview && (
            <div className="ord-actions">
              <button type="button" className="c-btn c-btn--ghost" disabled={busy === o.orderId} onClick={() => onReview(o.orderId, 'release')}>Release</button>
              <button type="button" className="c-btn c-btn--danger" disabled={busy === o.orderId} onClick={() => onReview(o.orderId, 'cancel')}>Cancel order</button>
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}

// ------------------------------------------------------------ spread map
export function SpreadMap({ spread }: { spread: SpreadRes | null }) {
  if (!spread) return <p className="c-empty">Select a chat to see where its decoys travelled.</p>;
  const downs = spread.nodes.filter((n) => n.role === 'downstream');
  const W = 520, H = Math.max(200, 70 + downs.length * 62);
  const src = { x: 96, y: H / 2 };
  const pos = downs.map((n, i) => ({ n, x: W - 120, y: downs.length === 1 ? H / 2 : 44 + (i * (H - 88)) / Math.max(1, downs.length - 1) }));
  const srcCode = spread.edges[0]?.decoyCode;
  return (
    <svg className="spread" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Leak spread map">
      <defs>
        <radialGradient id="spread-glow"><stop offset="0" stopColor="var(--t-leak)" stopOpacity=".55" /><stop offset="1" stopColor="var(--t-leak)" stopOpacity="0" /></radialGradient>
      </defs>
      {pos.map(({ n, x, y }, i) => {
        const same = n.sessionId === spread.sourceSessionId;
        const edge = spread.edges.find((e) => e.to === n.sessionId);
        const path = `M${src.x + 30} ${src.y} C ${src.x + 170} ${src.y}, ${x - 170} ${y}, ${x - 26} ${y}`;
        return (
          <g key={n.sessionId + i}>
            <path d={path} className="spread-edge" style={{ animationDelay: `${i * 0.25}s` }} />
            <text x={(src.x + x) / 2} y={(src.y + y) / 2 - 8} className="spread-edge-label">{prettyCode(edge?.decoyCode)}</text>
            <circle cx={x} cy={y} r="22" className={`spread-node ${n.payerId ? 'has-payer' : ''}`} />
            <text x={x} y={y + 4} textAnchor="middle" className="spread-node-label">{STORE_SHORT[n.storeId][0]}</text>
            <text x={x + 32} y={y - 4} className="spread-label">{same ? 'same chat' : chatLabel(n.sessionId)}</text>
            <text x={x + 32} y={y + 12} className="spread-sub">{n.payerId ? `payer ${n.payerId}` : 'not approved yet'}</text>
          </g>
        );
      })}
      <circle cx={src.x} cy={src.y} r="56" fill="url(#spread-glow)" />
      <circle cx={src.x} cy={src.y} r="30" className="spread-source" />
      <text x={src.x} y={src.y + 5} textAnchor="middle" className="spread-source-label">{chatLabel(spread.sourceSessionId, srcCode).replace('chat ', '')}</text>
      <text x={src.x} y={src.y + 50} textAnchor="middle" className="spread-sub">leak source</text>
      {!downs.length && <text x={W / 2} y={H / 2} textAnchor="middle" className="spread-sub">No one has redeemed this chat's decoys.</text>}
    </svg>
  );
}

// ------------------------------------------------------------ network
const REASONS: Record<string, string> = {
  'decoy:staff_code': 'Used a fake staff code',
  'decoy:refund_override': 'Used a fake manager code',
  'decoy:fake_floor': 'Paid a fake floor price',
  network: 'Matched an earlier blocked payer',
};
export const reasonLabel = (r: string) => REASONS[r] ?? r.replace(/^decoy:/, 'decoy: ').replace(/_/g, ' ');

export function NetworkView({ network, highlightPayer }: { network: NetworkRes | null; highlightPayer?: string }) {
  if (!network) return <p className="c-empty">Loading block list…</p>;
  // B starts a row at hits=0 and adds 1 for every later match (any store), so >= 1 means "caught again".
  const cross = network.blocked.filter((b) => b.hits >= 1).length;
  return (
    <div className="network">
      <div className="net-stores">
        <div className="net-store np"><span>N</span>Northpeak</div>
        <div className={`net-link${cross ? ' is-hot' : ''}`}><i /><em>{cross ? `${cross} payer${cross > 1 ? 's' : ''} matched again` : 'shared block list'}</em></div>
        <div className="net-store dw"><span>D</span>Driftwood</div>
      </div>
      <table className="net-table">
        <thead><tr><th>Payer</th><th>First seen</th><th>Why</th><th title="Later matches at any Mirage store">Repeat</th></tr></thead>
        <tbody>
          {network.blocked.map((b) => (
            <tr key={b.payerId} className={b.payerId === highlightPayer ? 'is-hl' : ''}>
              <td className="mono">{b.payerId}</td>
              <td>{STORE_SHORT[b.firstSeenStore]} · {shortDate(b.at)}</td>
              <td className="net-why" title={b.reason}>{reasonLabel(b.reason)}</td>
              <td><span className={`net-hits${b.hits >= 1 ? ' hot' : ''}`}>{b.hits}</span></td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="c-foot">Nobody is banned automatically. A match holds the order for a human.</p>
    </div>
  );
}

// ------------------------------------------------------------ risk
export function RiskView({ risk }: { risk: RiskPayloadsRes | null }) {
  const [open, setOpen] = useState<number | null>(null);
  if (!risk) return <p className="c-empty">Loading…</p>;
  if (!risk.payloads.length) return <p className="c-empty">Nothing sent yet.</p>;
  return (
    <ul className="risk">
      {risk.payloads.map((p, i) => (
        <li key={i}>
          <button type="button" className="risk-row" onClick={() => setOpen(open === i ? null : i)} aria-expanded={open === i}>
            <span className={`risk-badge ${p.ok ? 'ok' : 'bad'}`}>{p.ok ? 'OK' : 'FAILED'}{p.httpStatus ? ` ${p.httpStatus}` : ''}</span>
            <span className="mono">{p.orderId ?? '—'}</span>
            <span className="risk-time">{relTime(p.at)}</span>
            <span className="risk-caret">{open === i ? '▾' : '▸'}</span>
          </button>
          {open === i && <pre className="risk-body">{JSON.stringify(p.body, null, 2)}</pre>}
        </li>
      ))}
    </ul>
  );
}
