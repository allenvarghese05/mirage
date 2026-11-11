import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { NetworkRes, RiskPayloadsRes, SessionDetailRes, SessionsRes, SpreadRes } from '../../../shared/api';
import type { Severity, TripEvent } from '../../../shared/types';
import { api, type StreamStatus } from '../api/client';
import { ConsoleTopbar, chime } from '../console/Chrome';
import {
  AlarmFeed, DecoyKitView, RedemptionTrace, IdentityCard, NetworkView, OrdersView, Panel, Playbook, RiskView, SpreadMap, Transcript,
} from '../console/Panels';
import { kindMeta, STORE_NAMES, chatLabel, eventHeadline, learnFromEvents, registerSessionCode, relTime, sessionDecoyCode } from '../lib/format';
import '../styles/console.css';

const RANK: Record<Severity, number> = { info: 0, warn: 1, high: 2, critical: 3 };

interface Toast { id: string; e: TripEvent }

export function Dashboard() {
  const [params, setParams] = useSearchParams();
  const [events, setEvents] = useState<TripEvent[]>([]);
  const [sessions, setSessions] = useState<SessionsRes['sessions']>([]);
  const [detail, setDetail] = useState<SessionDetailRes | null>(null);
  const [spread, setSpread] = useState<SpreadRes | null>(null);
  const [network, setNetwork] = useState<NetworkRes | null>(null);
  const [risk, setRisk] = useState<RiskPayloadsRes | null>(null);
  const [stream, setStream] = useState<StreamStatus>('connecting');
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sound, setSound] = useState(() => {
    try { return localStorage.getItem('mirage.sound') !== '0'; } catch { return true; }
  });
  const soundRef = useRef(sound);
  soundRef.current = sound;

  const selected = params.get('session');
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const select = useCallback((id: string) => {
    setParams((p) => { const n = new URLSearchParams(p); n.set('session', id); return n; }, { replace: true });
  }, [setParams]);

  const refreshSide = useCallback(() => {
    api.network().then(setNetwork).catch(() => {});
    api.riskPayloads().then(setRisk).catch(() => {});
    api.sessions().then((r) => setSessions(r.sessions)).catch(() => {});
  }, []);

  // initial load
  useEffect(() => {
    document.title = 'Mirage · Security console';
    let live = true;
    Promise.all([api.events(), api.sessions()])
      .then(([ev, ss]) => {
        if (!live) return;
        learnFromEvents(ev.events);
        setEvents(ev.events);
        setSessions(ss.sessions);
        if (!selectedRef.current && ss.sessions.length) {
          const best = [...ss.sessions].sort((a, b) =>
            (RANK[b.topSeverity ?? 'info'] - RANK[a.topSeverity ?? 'info']) || (b.payerId ? 1 : 0) - (a.payerId ? 1 : 0) || a.startedAt.localeCompare(b.startedAt))[0];
          select(best.sessionId);
        }
      })
      .catch(() => live && setError('Cannot reach the Mirage server. Start it with `npm run dev`, or add ?mock=1 to the URL.'));
    refreshSide();
    return () => { live = false; };
  }, [refreshSide, select]);

  // live stream. Refreshes it triggers are coalesced (about 1 s), so a burst of events costs one round of requests.
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());
  const later = useCallback((fn: () => void, ms: number) => {
    const t = setTimeout(() => { timers.current.delete(t); fn(); }, ms);
    timers.current.add(t);
  }, []);
  useEffect(() => () => { timers.current.forEach(clearTimeout); timers.current.clear(); }, []);
  const pending = useRef({ detail: false, side: false, sessions: false, scheduled: false });

  useEffect(() => {
    const flush = () => {
      const p = pending.current;
      if (p.detail && selectedRef.current) loadDetailRef.current(selectedRef.current);
      if (p.side) refreshSide();
      else if (p.sessions) api.sessions().then((r) => setSessions(r.sessions)).catch(() => {});
      pending.current = { detail: false, side: false, sessions: false, scheduled: false };
    };
    return api.subscribe((e) => {
      learnFromEvents([e]);
      setEvents((prev) => (prev.some((x) => x.id === e.id) ? prev : [...prev, e]));
      setFresh((s) => new Set(s).add(e.id));
      later(() => setFresh((s) => { const n = new Set(s); n.delete(e.id); return n; }), 2400);
      if (e.severity === 'critical') {
        setToasts((t) => [...t.slice(-2), { id: e.id, e }]);
        later(() => setToasts((t) => t.filter((x) => x.id !== e.id)), 6000);
        if (soundRef.current) chime(e.kind === 'IDENTITY_CAPTURED' || e.kind === 'NETWORK_MATCH' ? 'identity' : 'critical');
      }
      const p = pending.current;
      if (e.sessionId === selectedRef.current) p.detail = true;
      if (['IDENTITY_CAPTURED', 'NETWORK_MATCH', 'RISK_SIGNAL_SENT', 'DECOY_REDEEMED', 'ORDER_HELD', 'REVIEW_DECISION'].includes(e.kind)) p.side = true;
      else p.sessions = true;
      if (!p.scheduled) { p.scheduled = true; later(flush, 1000); }
    }, setStream);
  }, [refreshSide, later]);

  const loadDetail = useCallback((id: string) => {
    api.sessionDetail(id).then((d) => { registerSessionCode(d.sessionId, d.decoys?.staffCode); learnFromEvents(d.events); if (selectedRef.current === id) setDetail(d); }).catch(() => setDetail(null));
    api.spread(id).then((s) => { if (selectedRef.current === id) setSpread(s); }).catch(() => setSpread(null));
  }, []);
  const loadDetailRef = useRef(loadDetail);
  loadDetailRef.current = loadDetail;

  useEffect(() => {
    if (!selected) return;
    setDetail(null); setSpread(null);
    loadDetail(selected);
  }, [selected, loadDetail]);

  const review = async (orderId: string, decision: 'release' | 'cancel') => {
    setBusy(orderId);
    try {
      await api.review(orderId, { decision, note: decision === 'release' ? 'Released by reviewer' : 'Cancelled by reviewer' });
      if (selected) loadDetail(selected);
      refreshSide();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const toggleSound = () => {
    const n = !sound;
    setSound(n);
    try { localStorage.setItem('mirage.sound', n ? '1' : '0'); } catch { /* ignore */ }
    if (n) chime();
  };

  const stats = useMemo(() => ({
    alarms: events.filter((e) => e.severity !== 'info').length,
    shadow: sessions.filter((s) => s.mode === 'shadow').length,
    identities: events.filter((e) => e.kind === 'IDENTITY_CAPTURED').length,
    held: events.filter((e) => e.kind === 'ORDER_HELD').length,
  }), [events, sessions]);

  const code = detail ? sessionDecoyCode(detail.events, detail.decoys?.staffCode) : undefined;
  const label = detail ? chatLabel(detail.sessionId, code) : '';
  // prefer the checkout redemption (has an order) over the in-chat fake-floor offer
  const redemptions = detail?.events.filter((e) => e.kind === 'DECOY_REDEEMED') ?? [];
  const redemption = redemptions.find((e) => e.detail.orderId) ?? redemptions[0];
  const networkHit = detail?.events.some((e) => e.kind === 'NETWORK_MATCH');
  const sessionMeta = sessions.find((s) => s.sessionId === selected);

  return (
    <div className="console">
      <ConsoleTopbar>
        <span className={`c-live st-${stream}`}><i />{stream === 'live' ? 'LIVE' : stream === 'mock' ? 'LIVE · MOCK' : stream === 'connecting' ? 'CONNECTING' : 'RECONNECTING'}</span>
        <button type="button" className={`c-btn c-btn--ghost c-sound${sound ? ' on' : ''}`} onClick={toggleSound} aria-pressed={sound}>
          {sound ? '♪ Sound on' : '♪ Sound off'}
        </button>
      </ConsoleTopbar>

      <div className="c-stats">
        <Stat label="Alarms" value={stats.alarms} />
        <Stat label="Chats in shadow mode" value={stats.shadow} tone="honey" />
        <Stat label="Identities captured" value={stats.identities} tone="identity" />
        <Stat label="Orders held" value={stats.held} />
        <Stat label="Real secrets in Mirage agents" value={0} tone="ok" big />
        <Stat label="Auto-charged on trapped orders" value="$0" tone="ok" big />
      </div>

      {error && <div className="c-error" role="alert">{error}<button type="button" onClick={() => setError(null)}>✕</button></div>}

      <div className="c-grid">
        <Panel title="Alarm feed" kicker={`${events.length} events`} className="c-col-feed">
          <AlarmFeed events={events} selectedSession={selected} onSelect={select} freshIds={fresh} />
        </Panel>

        <div className="c-col-detail">
          <section className="c-panel c-session-head">
            {detail ? (
              <>
                <div>
                  <span className="c-kicker">{STORE_NAMES[detail.storeId]} · {detail.storeMode === 'baseline' ? 'baseline store (real secrets)' : 'protected by Mirage'}</span>
                  <h2>{label} <span className="mono c-dim">{detail.sessionId}</span></h2>
                </div>
                <div className="c-session-badges">
                  <span className={`c-badge mode-${detail.mode}`}>{detail.mode === 'shadow' ? 'SHADOW MODE' : 'NORMAL'}</span>
                  {sessionMeta && <span className="c-badge">{relTime(sessionMeta.startedAt)}</span>}
                  <select value={selected ?? ''} onChange={(e) => select(e.target.value)} className="c-select" aria-label="Choose chat">
                    {sessions.map((s) => <option key={s.sessionId} value={s.sessionId}>{chatLabel(s.sessionId)} · {s.storeId} · {s.topSeverity ?? 'quiet'}</option>)}
                  </select>
                </div>
              </>
            ) : <p className="c-empty">{selected ? 'Loading chat…' : 'Select an alarm to open its chat.'}</p>}
          </section>

          {detail && (
            <div className="c-detail-grid">
              <Panel title="Transcript" kicker="tool calls and alarms inline" className="c-transcript-panel">
                <Transcript detail={detail} />
              </Panel>
              <div className="c-detail-side">
                {redemption && (
                  <Panel title="Code trace" kicker="where the leak came from" className="c-glow-honey">
                    <RedemptionTrace e={redemption} />
                  </Panel>
                )}
                <Panel title="Identity" kicker="revealed by PayPal" className={detail.identity ? 'c-glow-identity' : ''}>
                  <IdentityCard identity={detail.identity} storeId={detail.storeId} network={networkHit} showHistory />
                </Panel>
                <Panel title="Orders" kicker="human review">
                  <OrdersView orders={detail.orders} onReview={review} busy={busy} />
                </Panel>
                <Panel title="Playbook" kicker="techniques, in order">
                  <Playbook playbook={detail.playbook} events={detail.events} />
                </Panel>
                <Panel title="Decoy kit" kicker="what we planted">
                  <DecoyKitView kit={detail.decoys} storeId={detail.storeId} label={label} />
                </Panel>
              </div>
            </div>
          )}
        </div>

        <div className="c-col-side">
          <Panel title="Leak spread" kicker="source → redeemers">
            <SpreadMap spread={spread} />
          </Panel>
          <Panel title="Network" kicker="shared block list">
            <NetworkView network={network} highlightPayer={detail?.identity?.payerId} />
          </Panel>
          <Panel title="What we sent PayPal Risk" kicker="risk context payloads">
            <RiskView risk={risk} />
          </Panel>
        </div>
      </div>

      <div className="c-toasts" aria-live="assertive">
        {toasts.map(({ id, e }) => {
          const h = eventHeadline(e);
          return (
            <button type="button" key={id} className={`c-toast tone-${kindMeta(e.kind).tone}`} onClick={() => select(e.sessionId)}>
              <b>{h.title}</b><span>{h.sub}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function Stat({ label, value, tone, big }: { label: string; value: number | string; tone?: string; big?: boolean }) {
  return (
    <div className={`c-stat${tone ? ` tone-${tone}` : ''}${big ? ' big' : ''}`}>
      <span className="c-stat-v">{value}</span>
      <span className="c-stat-l">{label}</span>
    </div>
  );
}
