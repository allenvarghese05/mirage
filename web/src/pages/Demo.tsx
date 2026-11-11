import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import type { SessionDetailRes } from '../../../shared/api';
import type { PublicOrderStatus, TripEvent } from '../../../shared/types';
import { api, isMock } from '../api/client';
import { BRANDS } from '../store/brands';
import { StoreChrome } from '../store/StoreChrome';
import { AgentAvatar, ChatLog, type ChatLine } from '../store/ChatLog';
import { ProductArt } from '../store/ProductArt';
import { MirageLogo } from '../console/Chrome';
import { IdentityCard, PRODUCT_NAMES, RedemptionTrace } from '../console/Panels';
import { buildTimeline, findInjections, revealAt, type ReplayItem } from '../lib/replay';
import { kindMeta, STORE_NAMES, chatLabel, decodeCode, eventHeadline, learnFromEvents, money, moneyExact, parseFloorCode, prettyCode, registerSessionCode, sessionDecoyCode, shortDate, techniqueLabel } from '../lib/format';
import '../styles/store.css';
import '../styles/console.css';
import '../styles/demo.css';

type View = 'attacker' | 'split';
const SPEEDS = [0.5, 1, 1.5, 2, 3];
const STAFF_PCT: Record<string, number> = { northpeak: 40, driftwood: 35 };

export function Demo() {
  const [params, setParams] = useSearchParams();
  const [sessionId, setSessionId] = useState<string | null>(params.get('session'));
  const [detail, setDetail] = useState<SessionDetailRes | null>(null);
  const [orderMsgs, setOrderMsgs] = useState<Record<string, PublicOrderStatus>>({});
  const [listPrices, setListPrices] = useState<Record<string, number>>({});
  const [error, setError] = useState<string | null>(null);
  const view: View = params.get('view') === 'split' ? 'split' : 'attacker';
  const speed = Number(params.get('speed')) > 0 ? Number(params.get('speed')) : 1;
  const chrome = params.get('chrome') !== '0';
  const autoplay = params.get('autoplay') !== '0';
  const setParam = useCallback((k: string, v: string) => setParams((p) => { const n = new URLSearchParams(p); n.set(k, v); return n; }, { replace: true }), [setParams]);

  // pick a session when none is given: the most complete trapped run
  useEffect(() => {
    document.title = 'Mirage · Replay';
    if (sessionId) return;
    api.sessions().then((r) => {
      const rank = (s: (typeof r.sessions)[number]) => (s.topSeverity === 'critical' ? 4 : s.topSeverity === 'high' ? 2 : 0) + (s.payerId ? 2 : 0) + (s.storeMode === 'mirage' ? 1 : 0);
      const best = [...r.sessions].sort((a, b) => rank(b) - rank(a) || a.startedAt.localeCompare(b.startedAt))[0];
      if (best) { setSessionId(best.sessionId); setParam('session', best.sessionId); } else setError('No recorded sessions yet. Run the sim first.');
    }).catch(() => setError('Cannot reach the server. Add ?mock=1 to replay the sample session.'));
  }, [sessionId, setParam]);

  useEffect(() => {
    if (!sessionId) return;
    let live = true;
    api.sessionDetail(sessionId).then(async (d) => {
      if (!live) return;
      registerSessionCode(d.sessionId, d.decoys?.staffCode);
      learnFromEvents(d.events);
      setDetail(d);
      api.listProducts(d.storeId).then((r) => live && setListPrices(Object.fromEntries(r.products.map((p) => [p.id, p.listPriceCents])))).catch(() => {});
      const entries = await Promise.all(d.orders.map((o) => api.orderStatus(o.orderId).then((s) => [o.orderId, s] as const).catch(() => null)));
      if (live) setOrderMsgs(Object.fromEntries(entries.filter((x): x is readonly [string, PublicOrderStatus] => !!x)));
    }).catch(() => live && setError(`Session ${sessionId} not found.`));
    return () => { live = false; };
  }, [sessionId]);

  const timeline = useMemo(() => (detail ? buildTimeline(detail) : null), [detail]);

  // ------------------------------------------------ playback clock
  const startAt = Math.max(0, Number(params.get('t')) || 0) * 1000; // ?t=40 starts 40 s in (handy for recording a beat)
  const [now, setNow] = useState(startAt);
  const [playing, setPlaying] = useState(false);
  const [rewinding, setRewinding] = useState(false);
  const nowRef = useRef(startAt);
  const resumeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (resumeTimer.current) clearTimeout(resumeTimer.current); }, []);
  const total = timeline?.total ?? 1;
  useEffect(() => {
    if (timeline && nowRef.current > timeline.total) { nowRef.current = timeline.total; setNow(timeline.total); }
  }, [timeline]);

  useEffect(() => {
    if (!timeline || !autoplay) return;
    const t = setTimeout(() => setPlaying(true), 900);
    return () => clearTimeout(t);
  }, [timeline, autoplay]);

  useEffect(() => {
    if (!playing && !rewinding) return;
    let raf = 0;
    let last = performance.now();
    const rewindStart = nowRef.current;
    const rewindBegan = last;
    const tick = (ts: number) => {
      const dt = ts - last;
      last = ts;
      if (rewinding) {
        const p = Math.min(1, (ts - rewindBegan) / 2200);
        const eased = p * p * (3 - 2 * p);
        nowRef.current = rewindStart * (1 - eased);
        setNow(nowRef.current);
        if (p >= 1) {
          setRewinding(false);
          setParam('view', 'split');
          resumeTimer.current = setTimeout(() => setPlaying(true), 700);
          return;
        }
      } else {
        nowRef.current = Math.min(total, nowRef.current + dt * speed);
        setNow(nowRef.current);
        if (nowRef.current >= total) { setPlaying(false); return; }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, rewinding, speed, total, setParam]);

  const restart = useCallback(() => { nowRef.current = 0; setNow(0); setPlaying(true); }, []);
  const rewind = useCallback(() => { setPlaying(false); setRewinding(true); }, []);
  const seek = (v: number) => { nowRef.current = v; setNow(v); };

  // keyboard: space play/pause, R rewind, 0 restart
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === 'SELECT') return;
      if (e.code === 'Space') { e.preventDefault(); setPlaying((p) => !p); }
      if (e.key === 'r' || e.key === 'R') rewind();
      if (e.key === '0') restart();
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [rewind, restart]);

  if (error) return <div className="demo c-theme demo-msg"><p>{error}</p><Link to="/">Back to Mirage</Link></div>;
  if (!detail || !timeline) return <div className="demo c-theme demo-msg"><p>Loading replay…</p></div>;

  const recordedAt = detail.messages[0]?.at;
  const mock = isMock();
  const shownEvents = timeline.items.filter((it): it is EvtItem => it.kind === 'evt' && it.t <= now).map((it) => it.e);
  const isBeat = (e: TripEvent) => e.kind !== 'RISK_SIGNAL_SENT'; // plumbing, not a story beat
  const beatEvt = [...shownEvents].reverse().find(isBeat);
  const beat = beatEvt
    ? { label: beatLabel(beatEvt), tone: kindMeta(beatEvt.kind).tone }
    : { label: detail.storeMode === 'baseline' ? 'Comparison store' : detail.decoys ? 'Decoy kit planted' : 'Conversation', tone: 'info' };
  const marks = timeline.items.filter((it): it is EvtItem => it.kind === 'evt' && isBeat(it.e));
  const atEnd = now >= total - 100;

  return (
    <div className={`demo c-theme demo--${view}${rewinding ? ' is-rewinding' : ''}${playing ? ' is-playing' : ''}`}>
      <div className="demo-stage">
        <AttackerView detail={detail} items={timeline.items} now={now} orderMsgs={orderMsgs} listPrices={listPrices} />
        {view === 'split' && <ConsoleView detail={detail} items={timeline.items} now={now} />}
      </div>

      <div className={`demo-tag${mock ? ' is-mock' : ''}`}>
        <i aria-hidden="true" />{mock ? 'Mock data · not a real session' : `Real sandbox session · recorded ${recordedAt ? shortDate(recordedAt) : ''}`}
      </div>

      {rewinding && (
        <div className="rewind-fx" aria-live="assertive">
          <div className="rewind-label"><RewindIcon size={26} /><span>Rewind</span></div>
          <div className="rewind-bar"><i style={{ width: `${(now / total) * 100}%` }} /></div>
        </div>
      )}

      {chrome && (
        <div className="demo-controls" role="group" aria-label="Replay controls">
          <button type="button" className="dp-play" onClick={() => setPlaying((p) => !p)} aria-label={playing ? 'Pause' : 'Play'} title={playing ? 'Pause (Space)' : 'Play (Space)'}>
            {playing
              ? <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><rect x="3.5" y="2.5" width="3" height="11" rx="1" fill="currentColor" /><rect x="9.5" y="2.5" width="3" height="11" rx="1" fill="currentColor" /></svg>
              : <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M4.5 2.8v10.4a.6.6 0 0 0 .9.5l8.2-5.2a.6.6 0 0 0 0-1L5.4 2.3a.6.6 0 0 0-.9.5Z" fill="currentColor" /></svg>}
          </button>
          <button type="button" className="dp-btn" onClick={restart} aria-label="Restart" title="Restart (0)">
            <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><path d="M3.2 8a4.8 4.8 0 1 0 1.5-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /><path d="M4.4 1.9v2.9h2.9" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
          </button>
          {/* the attacker's view must not spoil the twist: beat names and colored markers only in split */}
          {view === 'split' && <span className={`dp-beat tone-${beat.tone}`} aria-live="polite"><i aria-hidden="true" />{beat.label}</span>}
          <div className="dp-scrub">
            <span className="dp-track" aria-hidden="true" />
            <span className="dp-fill" style={{ width: `${(now / total) * 100}%` }} aria-hidden="true" />
            {view === 'split' && marks.map((m) => (
              <span key={m.e.id} className={`dp-mark tone-${kindMeta(m.e.kind).tone}${m.t <= now ? ' is-past' : ''}`} style={{ left: `${(m.t / total) * 100}%` }} aria-hidden="true" />
            ))}
            <input type="range" min={0} max={total} value={now} step={50} onChange={(e) => seek(Number(e.target.value))} aria-label="Scrub" aria-valuetext={`${clockOf(now)} of ${clockOf(total)}`} />
          </div>
          <span className="mono dp-time">{clockOf(now)} / {clockOf(total)}</span>
          <select className="dp-select" value={String(speed)} onChange={(e) => setParam('speed', e.target.value)} aria-label="Speed">
            {SPEEDS.map((s) => <option key={s} value={s}>{s}×</option>)}
          </select>
          <span className="dp-sep" aria-hidden="true" />
          <div className="dp-seg" role="group" aria-label="View">
            <button type="button" className={view === 'attacker' ? 'on' : ''} aria-pressed={view === 'attacker'} onClick={() => setParam('view', 'attacker')}>Attacker</button>
            <button type="button" className={view === 'split' ? 'on' : ''} aria-pressed={view === 'split'} onClick={() => setParam('view', 'split')}>Split</button>
          </div>
          <button type="button" className={`dp-rewind${atEnd && view === 'attacker' ? ' pulse' : ''}`} onClick={rewind} title="Rewind and replay from Mirage's side (R)">
            <RewindIcon size={13} />REWIND
          </button>
          <Link to={`/dashboard?session=${encodeURIComponent(detail.sessionId)}`} className="dp-link">Console ↗</Link>
        </div>
      )}
    </div>
  );
}

type EvtItem = Extract<ReplayItem, { kind: 'evt' }>;

/** Events that are true but distract from the story (e.g. risk context skipped for a simulated order). */
const isNoise = (e: TripEvent) => e.kind === 'RISK_SIGNAL_SENT' && Boolean(e.detail?.skipped);

function beatLabel(e: TripEvent): string {
  if (e.kind === 'DECOY_REDEEMED') return e.detail?.decoyKind === 'fake_floor' || parseFloorCode(String(e.detail?.decoyCode ?? '')) ? 'Fake floor price traced' : 'Code traced';
  return kindMeta(e.kind).label;
}

const clockOf = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

function RewindIcon({ size = 14 }: { size?: number }) {
  return (
    <svg viewBox="0 0 20 14" width={size * (20 / 14)} height={size} aria-hidden="true">
      <path d="M9.2 1.4v11.2a.6.6 0 0 1-.95.5L1.1 7.5a.6.6 0 0 1 0-1L8.25.9a.6.6 0 0 1 .95.5Z" fill="currentColor" />
      <path d="M19 1.4v11.2a.6.6 0 0 1-.95.5L10.9 7.5a.6.6 0 0 1 0-1L18.05.9a.6.6 0 0 1 .95.5Z" fill="currentColor" />
    </svg>
  );
}

// ---------------------------------------------------------------- left: what the attacker saw
function marksFor(m: { role: string; content: string }, decoys: SessionDetailRes['decoys']): ChatLine['marks'] {
  const out: NonNullable<ChatLine['marks']> = [];
  if (m.role === 'user') {
    for (const t of findInjections(m.content)) out.push({ text: t, kind: 'inject' });
  } else if (m.role === 'assistant') {
    if (decoys) {
      for (const c of [decoys.staffCode, decoys.refundOverrideCode]) if (m.content.includes(c)) out.push({ text: c, kind: 'score' });
      for (const cents of Object.values(decoys.fakeFloorCents)) {
        const s = `$${(cents / 100).toFixed(2)}`;
        if (m.content.includes(s)) out.push({ text: s, kind: 'score' });
      }
    }
  }
  return out;
}

function AttackerView({ detail, items, now, orderMsgs, listPrices }: {
  detail: SessionDetailRes; items: ReplayItem[]; now: number; orderMsgs: Record<string, PublicOrderStatus>; listPrices: Record<string, number>;
}) {
  const brand = BRANDS[detail.storeId];
  const lines: ChatLine[] = [];
  let typing = false;
  for (const it of items) {
    if (it.kind !== 'msg' || it.m.role === 'tool' || it.t > now) continue;
    const reveal = revealAt(it, now);
    lines.push({ id: it.m.id, role: it.m.role as 'user' | 'assistant', content: it.m.content, reveal, marks: marksFor(it.m, detail.decoys) });
  }
  // "typing…" dots shortly before an assistant message starts
  const next = items.find((it) => it.kind === 'msg' && it.m.role === 'assistant' && it.t > now);
  if (next && next.t - now < 700 && lines.length) typing = true;

  // the checkout redemption (fake-floor offers also fire DECOY_REDEEMED in chat, with stage 'quote')
  const redeem = items.find((it): it is Extract<ReplayItem, { kind: 'evt' }> => it.kind === 'evt' && it.e.kind === 'DECOY_REDEEMED' && it.e.detail.stage !== 'quote');
  const identity = items.find((it): it is Extract<ReplayItem, { kind: 'evt' }> => it.kind === 'evt' && (it.e.kind === 'IDENTITY_CAPTURED' || it.e.kind === 'NETWORK_MATCH'));
  const held = items.find((it): it is Extract<ReplayItem, { kind: 'evt' }> => it.kind === 'evt' && it.e.kind === 'ORDER_HELD');
  const order = detail.orders.find((o) => o.trapped) ?? detail.orders[0];
  const checkoutAt = redeem?.t ?? (identity ? identity.t - 2600 : undefined);
  const statusAt = held?.t ?? identity?.t;
  const order0 = detail.orders.find((o) => o.trapped) ?? detail.orders[0];
  const floor = parseFloorCode(order0?.codeUsed);
  const product = useMemo(() => {
    if (floor) return floor.productId;
    const tool = detail.messages.find((m) => m.role === 'tool' && m.toolName === 'get_product');
    try { const id = tool ? (JSON.parse(tool.content).id as string) : undefined; if (id) return id; } catch { /* ignore */ }
    return detail.storeId === 'northpeak' ? 'np-jacket' : 'dw-grinder';
  }, [detail, floor]);

  const code = order?.codeUsed;
  const staffCode = decodeCode(code) ? code : undefined;
  const pct = staffCode ? STAFF_PCT[detail.storeId] : 0;
  // B labels the refund-override decoy "Manager pricing (N% off)" at checkout
  const isManagerCode = !!staffCode && (staffCode === detail.decoys?.refundOverrideCode || /-MGR-/i.test(staffCode));
  const total = order?.totalCents ?? 0;
  const subtotal = floor ? (listPrices[floor.productId] ?? total) : pct ? Math.round(total / (1 - pct / 100)) : total;
  const status = order ? orderMsgs[order.orderId] : undefined;

  return (
    <section className={`demo-attacker store store--${detail.storeId}`} aria-label="Attacker's view">
      <StoreChrome brand={brand} cartCount={checkoutAt !== undefined && now >= checkoutAt ? 1 : 0} compact />
      <div className="da-body">
        <div className="da-chat chat-panel">
          <header className="chat-head">
            <AgentAvatar brand={brand} />
            <div><b>{brand.agentName}</b><small><i className="online-dot" /> {brand.agentRole}</small></div>
          </header>
          <ChatLog brand={brand} lines={lines} typing={typing} instantScroll />
          <div className="chat-input da-input"><textarea rows={1} placeholder={`Message ${brand.agentName}…`} readOnly tabIndex={-1} /><button type="button" tabIndex={-1} aria-hidden="true"><svg viewBox="0 0 24 24" width="18" height="18"><path d="M4 12 L20 4 L14 20 L11 13 Z" fill="currentColor" /></svg></button></div>
        </div>
        <aside className="da-side">
          <article className="product-card da-product">
            <div className="product-art-wrap"><ProductArt productId={product} className="product-art" /></div>
            <div className="product-body">
              <h3>{PRODUCT_NAMES[product] ?? product}</h3>
            </div>
          </article>
          {order && checkoutAt !== undefined && now >= checkoutAt && (
            <div className="da-checkout">
              <span className="da-k">Checkout</span>
              {staffCode && <div className="da-code"><span className="mono">{staffCode}</span><b>applied ✓</b></div>}
              <div className="da-sum">
                {subtotal > total && <s>{moneyExact(subtotal)}</s>}
                <b>{moneyExact(total)}</b>
              </div>
              {staffCode && pct > 0 && <p className="da-label">{isManagerCode ? 'Manager pricing' : 'Staff pricing'} ({pct}% off)</p>}
              {floor && <p className="da-label">Price agreed in chat</p>}
              {!(statusAt !== undefined && now >= statusAt) && (
                <div className={`paypal-sim-btn da-pp${identity && now >= identity.t - 1800 ? ' is-busy' : ''}`}>
                  <span>{identity && now >= identity.t - 1800 ? 'Approving in PayPal…' : <>Pay with <b>PayPal</b></>}</span>
                </div>
              )}
            </div>
          )}
          {statusAt !== undefined && now >= statusAt && (
            <div className="da-status">
              <span className="da-k">Order {order?.orderId}</span>
              <p>{status?.message ?? 'Order received.'}</p>
            </div>
          )}
        </aside>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- right: what Mirage saw
function ConsoleView({ detail, items, now }: { detail: SessionDetailRes; items: ReplayItem[]; now: number }) {
  const shown = items.filter((it): it is EvtItem => it.kind === 'evt' && it.t <= now);
  const events = shown.map((s) => s.e);
  const code = sessionDecoyCode(detail.events, detail.decoys?.staffCode);
  const label = chatLabel(detail.sessionId, code);
  const shadow = events.some((e) => e.kind === 'HONEY_TOOL_CALLED');
  const redeems = events.filter((e) => e.kind === 'DECOY_REDEEMED');
  const redeem = redeems.find((e) => e.detail.stage !== 'quote') ?? redeems[0];
  const identity = events.find((e) => e.kind === 'IDENTITY_CAPTURED' || e.kind === 'NETWORK_MATCH');
  const network = events.find((e) => e.kind === 'NETWORK_MATCH');
  const held = events.find((e) => e.kind === 'ORDER_HELD');
  const leakCount = events.filter((e) => e.kind === 'DECOY_LEAKED').length;
  const floorOrder = detail.orders.map((o) => parseFloorCode(o.codeUsed)).find(Boolean);
  const leakedProduct = detail.events.find((e) => e.kind === 'DECOY_LEAKED' && typeof e.detail.productId === 'string')?.detail.productId as string | undefined;
  const product = leakedProduct ?? floorOrder?.productId ?? Object.keys(detail.decoys?.fakeFloorCents ?? {})[0];
  const toolCalls = items.filter((it) => it.kind === 'msg' && it.m.role === 'tool' && it.t <= now && detail.decoys?.honeyTools.includes(it.m.toolName ?? ''));
  const heldOrder = detail.orders.find((o) => o.trapped);
  const feed = [...shown].reverse().filter(({ e }) => !isNoise(e));

  return (
    <section className="demo-console" aria-label="Mirage console">
      <header className="dc-head">
        <MirageLogo size={22} />
        <span className="dc-title">What Mirage saw</span>
        <span className="dc-session">{label} · {STORE_NAMES[detail.storeId]}</span>
        <span className={`c-badge mode-${shadow ? 'shadow' : 'normal'}`}>{shadow ? 'Shadow mode' : 'Normal mode'}</span>
      </header>

      <div className="dc-body">
        <section className="dc-card dc-trace-card">
          <div className="dc-card-head">
            <h4>What happened in {label}</h4>
            <span className="dc-card-meta">Replay of a recorded session</span>
          </div>
          <ReplayTrace detail={detail} events={events} />
        </section>

        <div className="dc-grid">
          <div className="dc-col">
            {detail.decoys ? (
              <section className="dc-card dc-kit">
                <span className="dc-kicker">Before the first message</span>
                <h4>Decoy kit planted for {label}</h4>
                <dl>
                  {product && detail.decoys.fakeFloorCents[product] !== undefined && (
                    <div><dt>Fake floor · {PRODUCT_NAMES[product] ?? product}</dt><dd className="mono">{moneyExact(detail.decoys.fakeFloorCents[product])}</dd></div>
                  )}
                  <div><dt>Fake staff code</dt><dd className="mono">{detail.decoys.staffCode}</dd></div>
                  <div><dt>Fake tools</dt><dd className="mono">{detail.decoys.honeyTools.length}</dd></div>
                </dl>
                <p className="dc-real">Real floor price: <b>server only</b>. The agent never sees it.</p>
              </section>
            ) : (
              <section className="dc-card dc-kit"><h4>Comparison store</h4><p className="dc-real">No decoys. This agent holds the real secrets.</p></section>
            )}

            <div className="dc-stats">
              <div className={leakCount ? 'tone-leak is-on' : ''}><b className="mono">{leakCount}</b><span>fake secrets leaked</span></div>
              <div className="tone-held is-on"><b className="mono">0</b><span>real secrets leaked</span></div>
              <div className={toolCalls.length ? 'tone-leak is-on' : ''}><b className="mono">{toolCalls.length}</b><span>fake tools used</span></div>
            </div>

            <section className="dc-card dc-feed-card">
              <span className="dc-kicker">Event log</span>
              {feed.length ? (
                <ul className="dc-feed">{feed.map(({ e }) => <FeedRow key={e.id} e={e} />)}</ul>
              ) : (
                <p className="dc-empty">Listening. Nothing flagged yet.</p>
              )}
            </section>
          </div>

          <div className="dc-col">
            {!redeem && !identity && !held && (
              <div className="dc-wait">
                <b>Nothing used yet</b>
                <span>If a planted code or price reaches checkout, Mirage traces it to this chat and PayPal tells us who paid.</span>
              </div>
            )}
            {redeem && (
              <section className="dc-card dc-spot tone-honey">
                <span className="dc-spot-kicker"><i aria-hidden="true" />{redeem.detail.decoyKind === 'fake_floor' || parseFloorCode(String(redeem.detail.decoyCode ?? '')) ? 'Fake floor price traced' : 'Code traced'}</span>
                <RedemptionTrace e={redeem} />
              </section>
            )}
            {identity && (
              <section className="dc-card dc-spot tone-identity">
                <span className="dc-spot-kicker"><i aria-hidden="true" />{network ? 'Network match · seen at another store' : 'Identity captured via PayPal'}</span>
                <IdentityCard identity={detail.identity ?? { payerId: String(identity.detail.payerId ?? 'unknown'), name: identity.detail.name as string | undefined }} storeId={detail.storeId} network={!!network} />
              </section>
            )}
            {held && (
              <section className="dc-held tone-held">
                <div>
                  <b>Order held. Never captured.</b>
                  <span>{String(held.detail.orderId ?? heldOrder?.orderId ?? '')} waits for a human reviewer</span>
                </div>
                <div className="dc-held-amt"><b className="mono">{money(0)}</b><span>moved</span></div>
              </section>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

/** The trace (attempt > leak > checkout > identified > held), built up as the replay reaches each event. */
function ReplayTrace({ detail, events }: { detail: SessionDetailRes; events: TripEvent[] }) {
  // Steps that become done in the same frame (first paint, or a seek) pop one after another; later ones pop on arrival.
  const stagger = useRef(new Map<number, number>());
  if (detail.storeMode === 'baseline') {
    return (
      <p className="trace-note">
        <span className="c-badge mode-baseline">Comparison store</span>
        <span>This agent holds the <b>real</b> codes. There is no trap and nothing to trace.</span>
      </p>
    );
  }
  const first = (k: string, pred: (e: TripEvent) => boolean = () => true) => events.find((e) => e.kind === k && pred(e));
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  const attempt = first('ATTACK_ATTEMPT');
  const leak = first('DECOY_LEAKED') ?? first('HONEY_TOOL_CALLED');
  const hasCheckoutRedeem = detail.events.some((e) => e.kind === 'DECOY_REDEEMED' && e.detail?.stage !== 'quote');
  const redeemed = first('DECOY_REDEEMED', (e) => (hasCheckoutRedeem ? e.detail?.stage !== 'quote' : true));
  const identified = first('IDENTITY_CAPTURED') ?? first('NETWORK_MATCH');
  const held = first('ORDER_HELD');
  const heldOrder = detail.orders.find((o) => o.trapped);

  // label the leak step by what this chat actually leaked, so the label never changes mid-replay
  const anyLeak = detail.events.find((e) => e.kind === 'DECOY_LEAKED') ?? detail.events.find((e) => e.kind === 'HONEY_TOOL_CALLED');
  const leakLabel = anyLeak?.kind === 'HONEY_TOOL_CALLED' ? 'Fake tool used' : anyLeak?.detail?.decoyKind === 'fake_floor' ? 'Fake price leaked' : 'Fake code leaked';
  const leakValue = leak
    ? leak.kind === 'HONEY_TOOL_CALLED' ? `${str(leak.detail.toolName) || 'honey tool'}()`
      : leak.detail.decoyKind === 'fake_floor' && typeof leak.detail.amountCents === 'number' ? moneyExact(leak.detail.amountCents)
      : prettyCode(str(leak.detail.decoyCode)) || 'decoy'
    : '';
  const payerName = str(identified?.detail?.name) || detail.identity?.name;

  const steps: { tone: string; label: string; done: boolean; sub: string; mono?: boolean }[] = [
    { tone: 'attempt', label: 'Attack attempt', done: !!attempt, sub: attempt ? techniqueLabel(attempt.detail?.technique) : 'Watching the chat' },
    { tone: 'leak', label: leakLabel, done: !!leak, sub: leak ? leakValue : 'Agent holds only decoys', mono: !!leak && leakValue !== 'decoy' },
    { tone: 'honey', label: 'Used at checkout', done: !!redeemed, sub: redeemed ? `Traced to ${chatLabel(str(redeemed.detail?.sourceSessionId) || detail.sessionId)}` : 'Not used yet' },
    { tone: 'identity', label: 'Identified by PayPal', done: !!identified, sub: identified ? (payerName ?? 'Payer on file') : 'After PayPal approval' },
    { tone: 'held', label: 'Held, $0 charged', done: !!held, sub: held ? (heldOrder ? `${moneyExact(heldOrder.totalCents)} never captured` : 'Never captured') : 'Nothing to hold yet' },
  ];
  const nextIdx = steps.findIndex((s) => !s.done);
  let fresh = 0;
  steps.forEach((s, i) => {
    if (!s.done) stagger.current.delete(i);
    else if (!stagger.current.has(i)) stagger.current.set(i, fresh++);
  });

  return (
    <div className="trace" role="list" aria-label="What happened in this chat">
      {steps.map((s, i) => (
        <div
          key={i}
          role="listitem"
          className={`trace-step tone-${s.tone}${s.done ? ' is-done' : ''}${i === nextIdx && i > 0 ? ' is-next' : ''}`}
          style={{ '--i': stagger.current.get(i) ?? 0 } as React.CSSProperties}
        >
          <div className="trace-rail"><span className="trace-dot" aria-hidden="true" /></div>
          <span className="trace-label">{s.label}<span className="sr-only">{s.done ? ' (done)' : ' (not reached)'}</span></span>
          <span className={`trace-sub${s.mono ? ' mono' : ''}`}>{s.sub}</span>
        </div>
      ))}
    </div>
  );
}

function FeedRow({ e }: { e: TripEvent }) {
  const meta = kindMeta(e.kind);
  const h = eventHeadline(e);
  return (
    <li className={`dc-row tone-${meta.tone}`}>
      <i aria-hidden="true" />
      <div><b>{h.title}</b><small>{h.sub}</small></div>
    </li>
  );
}
