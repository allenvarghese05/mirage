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
import { CodeDecode, IdentityCard, PRODUCT_NAMES } from '../console/Panels';
import { buildTimeline, revealAt, type ReplayItem } from '../lib/replay';
import { KIND_META, STORE_NAMES, chatLabel, eventHeadline, money, moneyExact, sessionDecoyCode, shortDate } from '../lib/format';
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
      setDetail(d);
      const entries = await Promise.all(d.orders.map((o) => api.orderStatus(o.orderId).then((s) => [o.orderId, s] as const).catch(() => null)));
      if (live) setOrderMsgs(Object.fromEntries(entries.filter((x): x is readonly [string, PublicOrderStatus] => !!x)));
    }).catch(() => live && setError(`Session ${sessionId} not found.`));
    return () => { live = false; };
  }, [sessionId]);

  const timeline = useMemo(() => (detail ? buildTimeline(detail) : null), [detail]);

  // ------------------------------------------------ playback clock
  const [now, setNow] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [rewinding, setRewinding] = useState(false);
  const nowRef = useRef(0);
  const total = timeline?.total ?? 1;

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
          setTimeout(() => setPlaying(true), 700);
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

  const restart = () => { nowRef.current = 0; setNow(0); setPlaying(true); };
  const rewind = () => { setPlaying(false); setRewinding(true); };
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
  });

  if (error) return <div className="demo demo-msg"><p>{error}</p><Link to="/">← Mirage</Link></div>;
  if (!detail || !timeline) return <div className="demo demo-msg"><p>Loading replay…</p></div>;

  const recordedAt = detail.messages[0]?.at;
  const mock = isMock();

  return (
    <div className={`demo demo--${view}${rewinding ? ' is-rewinding' : ''}`}>
      <div className="demo-stage">
        <AttackerView detail={detail} items={timeline.items} now={now} orderMsgs={orderMsgs} split={view === 'split'} />
        {view === 'split' && <ConsoleView detail={detail} items={timeline.items} now={now} />}
      </div>

      <div className="demo-tag">
        <i />{mock ? 'Mock data · not a real session' : `Real sandbox session · recorded ${recordedAt ? shortDate(recordedAt) : ''}`}
      </div>
      {view === 'split' && !rewinding && <div className="demo-split-label"><span>What he saw</span><span>What Mirage saw</span></div>}

      {rewinding && (
        <div className="rewind-fx" aria-live="assertive">
          <div className="rewind-label">◀◀ REWIND</div>
          <div className="rewind-noise" />
        </div>
      )}

      {chrome && (
        <div className="demo-controls">
          <button type="button" onClick={() => setPlaying((p) => !p)} aria-label={playing ? 'Pause' : 'Play'}>{playing ? '❚❚' : '▶'}</button>
          <button type="button" onClick={restart} aria-label="Restart">↺</button>
          <input type="range" min={0} max={total} value={now} step={50} onChange={(e) => seek(Number(e.target.value))} aria-label="Scrub" />
          <span className="mono demo-time">{(now / 1000).toFixed(1)}s / {(total / 1000).toFixed(0)}s</span>
          <select value={String(speed)} onChange={(e) => setParam('speed', e.target.value)} aria-label="Speed">
            {SPEEDS.map((s) => <option key={s} value={s}>{s}×</option>)}
          </select>
          <div className="demo-seg">
            <button type="button" className={view === 'attacker' ? 'on' : ''} onClick={() => setParam('view', 'attacker')}>Attacker</button>
            <button type="button" className={view === 'split' ? 'on' : ''} onClick={() => setParam('view', 'split')}>Split</button>
          </div>
          <button type="button" className={`demo-rewind${now >= total - 100 && view === 'attacker' ? ' pulse' : ''}`} onClick={rewind}>◀◀ REWIND</button>
          <Link to={`/dashboard?session=${encodeURIComponent(detail.sessionId)}`} className="demo-link">console ↗</Link>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- left: what the attacker saw
function marksFor(m: { role: string; content: string }, decoys: SessionDetailRes['decoys']): ChatLine['marks'] {
  const out: NonNullable<ChatLine['marks']> = [];
  if (m.role === 'user') {
    const inj = m.content.match(/\[[^\]]*(ignore|instruction|system|assistant)[^\]]*\]/i);
    if (inj) out.push({ text: inj[0], kind: 'inject' });
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

function AttackerView({ detail, items, now, orderMsgs, split }: {
  detail: SessionDetailRes; items: ReplayItem[]; now: number; orderMsgs: Record<string, PublicOrderStatus>; split: boolean;
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

  const redeem = items.find((it): it is Extract<ReplayItem, { kind: 'evt' }> => it.kind === 'evt' && it.e.kind === 'DECOY_REDEEMED');
  const identity = items.find((it): it is Extract<ReplayItem, { kind: 'evt' }> => it.kind === 'evt' && (it.e.kind === 'IDENTITY_CAPTURED' || it.e.kind === 'NETWORK_MATCH'));
  const held = items.find((it): it is Extract<ReplayItem, { kind: 'evt' }> => it.kind === 'evt' && it.e.kind === 'ORDER_HELD');
  const order = detail.orders.find((o) => o.trapped) ?? detail.orders[0];
  const checkoutAt = redeem?.t ?? (identity ? identity.t - 2600 : undefined);
  const statusAt = held?.t ?? identity?.t;
  const product = useMemo(() => {
    const tool = detail.messages.find((m) => m.role === 'tool' && m.toolName === 'get_product');
    try { const id = tool ? (JSON.parse(tool.content).id as string) : undefined; if (id) return id; } catch { /* ignore */ }
    return detail.storeId === 'northpeak' ? 'np-jacket' : 'dw-grinder';
  }, [detail]);

  const code = order?.codeUsed;
  const pct = code ? STAFF_PCT[detail.storeId] : 0;
  const total = order?.totalCents ?? 0;
  const subtotal = pct ? Math.round(total / (1 - pct / 100)) : total;
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
          <ChatLog brand={brand} lines={lines} typing={typing} />
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
              {code && <div className="da-code"><span className="mono">{code}</span><b>applied ✓</b></div>}
              <div className="da-sum">
                {code && subtotal !== total && <s>{moneyExact(subtotal)}</s>}
                <b>{moneyExact(total)}</b>
              </div>
              {code && pct > 0 && <p className="da-label">Staff pricing ({pct}% off)</p>}
              {!(statusAt !== undefined && now >= statusAt) && (
                <div className={`paypal-sim-btn da-pp${identity && now >= identity.t - 1800 ? ' is-busy' : ''}`}>
                  {identity && now >= identity.t - 1800 ? 'Approving in PayPal…' : <>Pay with <b>PayPal</b></>}
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
      {!split && <div className="da-vignette" aria-hidden="true" />}
    </section>
  );
}

// ---------------------------------------------------------------- right: what Mirage saw
function ConsoleView({ detail, items, now }: { detail: SessionDetailRes; items: ReplayItem[]; now: number }) {
  const shown = items.filter((it): it is Extract<ReplayItem, { kind: 'evt' }> => it.kind === 'evt' && it.t <= now);
  const events = shown.map((s) => s.e);
  const code = sessionDecoyCode(detail.events, detail.decoys?.staffCode);
  const label = chatLabel(detail.sessionId, code);
  const shadow = events.some((e) => e.kind === 'HONEY_TOOL_CALLED');
  const redeem = events.find((e) => e.kind === 'DECOY_REDEEMED');
  const identity = events.find((e) => e.kind === 'IDENTITY_CAPTURED' || e.kind === 'NETWORK_MATCH');
  const network = events.find((e) => e.kind === 'NETWORK_MATCH');
  const held = events.find((e) => e.kind === 'ORDER_HELD');
  const leaked = events.some((e) => e.kind === 'DECOY_LEAKED');
  const product = Object.keys(detail.decoys?.fakeFloorCents ?? {})[0];
  const toolCalls = items.filter((it) => it.kind === 'msg' && it.m.role === 'tool' && it.t <= now && detail.decoys?.honeyTools.includes(it.m.toolName ?? ''));

  return (
    <section className="demo-console c-theme" aria-label="Mirage console">
      <header className="dc-head">
        <MirageLogo size={24} />
        <span className="dc-chat mono">{label} · {STORE_NAMES[detail.storeId]}</span>
        <span className={`c-badge mode-${shadow ? 'shadow' : 'normal'}`}>{shadow ? 'SHADOW MODE' : 'NORMAL'}</span>
      </header>
      <div className="dc-grid">
        <div className="dc-left">
          {detail.decoys ? (
            <div className="dc-card dc-kit">
              <span className="c-kicker">Before the first message</span>
              <h4>Decoy kit planted for {label}</h4>
              <dl>
                {product && <div><dt>Fake floor · {PRODUCT_NAMES[product]?.split(' ')[0]}</dt><dd className="mono glow">{moneyExact(detail.decoys.fakeFloorCents[product])}</dd></div>}
                <div><dt>Fake staff code</dt><dd className="mono glow">…{detail.decoys.staffCode.split('-').slice(-2).join('-')}</dd></div>
                <div><dt>Fake tools</dt><dd className="mono">{detail.decoys.honeyTools.length}</dd></div>
              </dl>
              <p className="dc-real">Real floor price: <b>server only</b>. The agent never sees it.</p>
            </div>
          ) : (
            <div className="dc-card"><h4>Baseline store</h4><p className="c-empty">No decoys. This agent holds the real secrets.</p></div>
          )}
          <div className="dc-counter">
            <div><span className={leaked ? 'hot' : ''}>{events.filter((e) => e.kind === 'DECOY_LEAKED').length}</span><small>fake secrets leaked</small></div>
            <div><span className="zero">0</span><small>real secrets leaked</small></div>
            <div><span className={toolCalls.length ? 'hot-red' : ''}>{toolCalls.length}</span><small>fake tools used</small></div>
          </div>
          <ul className="dc-feed">
            {[...shown].reverse().map(({ e }) => <FeedRow key={e.id} e={e} />)}
          </ul>
        </div>
        <div className="dc-right">
          {redeem && typeof redeem.detail.decoyCode === 'string' && (
            <div className="dc-card dc-spot tone-honey">
              <span className="c-kicker">🔔 Code traced</span>
              <CodeDecode code={redeem.detail.decoyCode} sourceSessionId={String(redeem.detail.sourceSessionId ?? '')} valid={redeem.detail.signatureValid !== false} />
            </div>
          )}
          {identity && (
            <div className="dc-card dc-spot tone-identity">
              <span className="c-kicker">{network ? '⟁ Network match · seen at another store' : '◉ Identity captured via PayPal'}</span>
              <IdentityCard identity={detail.identity ?? { payerId: String(identity.detail.payerId ?? 'unknown'), name: identity.detail.name as string | undefined }} storeId={detail.storeId} network={!!network} />
            </div>
          )}
          {held && (
            <div className="dc-held">
              <b>Order held. Never captured.</b>
              <span>{money(0)} moved · {String(held.detail.orderId ?? '')} waits for a human</span>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function FeedRow({ e }: { e: TripEvent }) {
  const meta = KIND_META[e.kind];
  const h = eventHeadline(e);
  return (
    <li className={`dc-row tone-${meta.tone}`}>
      <span className="alarm-glyph">{meta.glyph}</span>
      <div><b>{h.title}</b><small>{h.sub}</small></div>
    </li>
  );
}
