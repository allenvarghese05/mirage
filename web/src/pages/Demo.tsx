import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import type { SessionDetailRes } from '../../../shared/api';
import type { PublicOrderStatus, TripEvent } from '../../../shared/types';
import { api, isMock } from '../api/client';
import { BRANDS } from '../store/brands';
import { StoreChrome } from '../store/StoreChrome';
import { AgentAvatar, ChatLog, type ChatLine } from '../store/ChatLog';
import { ProductArt } from '../store/ProductArt';
import { PRODUCT_NAMES } from '../console/Panels';
import { MirageStory } from '../demo/MirageStory';
import { buildTimeline, findInjections, revealAt, type ReplayItem } from '../lib/replay';
import { kindMeta, decodeCode, learnFromEvents, moneyExact, parseFloorCode, registerSessionCode, shortDate } from '../lib/format';
import '../styles/store.css';
import '../styles/console.css';
import '../styles/demo.css';

type View = 'attacker' | 'mirage' | 'split';
const SPEEDS = [0.5, 1, 1.5, 2, 3];
const STAFF_PCT: Record<string, number> = { northpeak: 40, driftwood: 35 };

export function Demo() {
  const [params, setParams] = useSearchParams();
  const [sessionId, setSessionId] = useState<string | null>(params.get('session'));
  const [detail, setDetail] = useState<SessionDetailRes | null>(null);
  const [orderMsgs, setOrderMsgs] = useState<Record<string, PublicOrderStatus>>({});
  const [listPrices, setListPrices] = useState<Record<string, number>>({});
  const [error, setError] = useState<string | null>(null);
  const view: View = params.get('view') === 'split' ? 'split' : params.get('view') === 'mirage' ? 'mirage' : 'attacker';
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
          setParam('view', 'mirage');
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
        {view !== 'mirage' && <AttackerView detail={detail} items={timeline.items} now={now} orderMsgs={orderMsgs} listPrices={listPrices} />}
        {view !== 'attacker' && <MirageStory detail={detail} events={shownEvents} compact={view === 'split'} mock={mock} />}
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
          {view !== 'attacker' && <span className={`dp-beat tone-${beat.tone}`} aria-live="polite"><i aria-hidden="true" />{beat.label}</span>}
          <div className="dp-scrub">
            <span className="dp-track" aria-hidden="true" />
            <span className="dp-fill" style={{ width: `${(now / total) * 100}%` }} aria-hidden="true" />
            {view !== 'attacker' && marks.map((m) => (
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
            <button type="button" className={view === 'attacker' ? 'on' : ''} aria-pressed={view === 'attacker'} onClick={() => setParam('view', 'attacker')}>Store</button>
            <button type="button" className={view === 'mirage' ? 'on' : ''} aria-pressed={view === 'mirage'} onClick={() => setParam('view', 'mirage')}>Mirage</button>
            <button type="button" className={view === 'split' ? 'on' : ''} aria-pressed={view === 'split'} onClick={() => setParam('view', 'split')}>Both</button>
          </div>
          {view === 'attacker' && (
            <button type="button" className={`dp-rewind${atEnd ? ' pulse' : ''}`} onClick={rewind} title="Rewind and replay from Mirage's side (R)">
              <RewindIcon size={13} />Rewind
            </button>
          )}
          {view === 'attacker' && <span className={`dp-note${mock ? ' is-mock' : ''}`}>{mock ? 'Mock data' : `Real sandbox session · ${recordedAt ? shortDate(recordedAt) : ''}`}</span>}
          <Link to={`/dashboard?session=${encodeURIComponent(detail.sessionId)}`} className="dp-link">Open in console</Link>
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
