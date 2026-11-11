import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { AgGridReact } from 'ag-grid-react';
import {
  AllCommunityModule, ModuleRegistry, themeQuartz, type ColDef, type ICellRendererParams, type RowClickedEvent,
} from 'ag-grid-community';
import type { ScoreboardRes, SessionDetailRes } from '../../../shared/api';
import type { ScoreboardSummary, SimRun } from '../../../shared/types';
import { api } from '../api/client';
import { ConsoleTopbar } from '../console/Chrome';
import { Transcript } from '../console/Panels';
import { useCountUp } from '../lib/useCountUp';
import { STORE_SHORT, chatLabel, money, sessionDecoyCode, titleCase } from '../lib/format';
import '../styles/console.css';
import '../styles/scoreboard.css';

ModuleRegistry.registerModules([AllCommunityModule]);

// Light grid that reads the console tokens directly (the grid renders inside .console).
const gridTheme = themeQuartz.withParams({
  backgroundColor: 'var(--c-panel)',
  foregroundColor: 'var(--c-text)',
  textColor: 'var(--c-text)',
  subtleTextColor: 'var(--c-faint)',
  headerBackgroundColor: 'var(--c-bg-2)',
  headerTextColor: 'var(--c-dim)',
  borderColor: 'var(--c-line)',
  rowBorder: { color: 'var(--c-line)' },
  columnBorder: false,
  headerColumnBorder: false,
  wrapperBorder: { color: 'var(--c-line)' },
  accentColor: 'var(--t-identity-dot)',
  rowHoverColor: 'var(--c-bg-2)',
  selectedRowBackgroundColor: 'var(--c-panel-2)',
  oddRowBackgroundColor: 'var(--c-panel)',
  fontFamily: 'var(--sans)',
  headerFontFamily: 'var(--sans)',
  headerFontWeight: 500,
  headerFontSize: 12.5,
  fontSize: 13,
  rowHeight: 40,
  headerHeight: 38,
  spacing: 6,
  cellHorizontalPadding: 14,
  wrapperBorderRadius: 12,
  borderRadius: 7,
  iconSize: 14,
});

// Batches recorded for the writeup (docs/README). The server defaults to the latest batch when none is chosen.
const KNOWN_BATCHES = ['full-1', 'full-2', 'hardened-1', 'sonnet-attack-1'];

type Who = 'all' | 'attack' | 'honest';
type ModeF = 'both' | 'baseline' | 'mirage';

const STAGE: Record<SimRun['detectedStage'], string> = {
  none: '—', chat_attempt: 'Chat attempt', chat_leak: 'Chat leak', honey_tool: 'Fake tool', checkout: 'Checkout', identity: 'Identity',
};

/** Sim ids look like `full-1-0001-f3e31b`; the batch is already in the header, so show `#0001`. */
const shortRunId = (id: string) => /^.+-(\d{3,})-[0-9a-f]{4,}$/.exec(id)?.[1].replace(/^/, '#') ?? id;

const Na = () => <span className="sb-na">—</span>;
const yes = (tone?: 'identity') => (p: ICellRendererParams<SimRun, boolean | null>) =>
  p.value === null || p.value === undefined ? <Na /> : p.value ? <span className={tone ? 'sb-id' : 'sb-yes'}>✓</span> : <span className="sb-na">✗</span>;

function usePrefersReducedMotion() {
  const [reduced] = useState(() => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  return reduced;
}

export function Scoreboard() {
  const [data, setData] = useState<ScoreboardRes | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [params, setParams] = useSearchParams();
  const [open, setOpen] = useState<SimRun | null>(null);
  const [replayKey, setReplayKey] = useState(0);

  const who = (params.get('who') as Who) || 'all';
  const mode = (params.get('mode') as ModeF) || 'both';
  const whiteBox = params.get('wb') === '1';
  const technique = params.get('technique') ?? '';
  const batchParam = params.get('batchId') ?? '';
  const setF = (k: string, v: string | null) => setParams((p) => { const n = new URLSearchParams(p); if (v === null || v === '') n.delete(k); else n.set(k, v); return n; }, { replace: true });

  useEffect(() => {
    document.title = 'Mirage · Scoreboard';
    setError(null);
    api.scoreboard(batchParam || undefined).then(setData).catch(() => setError('Cannot load the scoreboard. Is the server running? (Or add ?mock=1)'));
  }, [batchParam]);

  const rows = useMemo(() => (data?.runs ?? []).filter((r) =>
    (who === 'all' || (who === 'attack' ? r.isAttack : !r.isAttack)) &&
    (mode === 'both' || r.storeMode === mode) &&
    (!whiteBox || r.whiteBox) &&
    (!technique || r.technique === technique)), [data, who, mode, whiteBox, technique]);
  const techniques = useMemo(() => [...new Set((data?.runs ?? []).map((r) => r.technique))].sort(), [data]);
  const batches = useMemo(() => {
    const cur = data?.batchId;
    return cur && !KNOWN_BATCHES.includes(cur) ? [cur, ...KNOWN_BATCHES] : KNOWN_BATCHES;
  }, [data?.batchId]);

  const cols = useMemo<ColDef<SimRun>[]>(() => [
    { field: 'id', headerName: 'Run', width: 84, pinned: 'left', cellClass: 'sb-mono', valueFormatter: (p) => shortRunId(String(p.value ?? '')), tooltipField: 'id' },
    { field: 'storeMode', headerName: 'Store', width: 112, cellRenderer: (p: ICellRendererParams<SimRun, string>) => (
      <span className={`sb-store sb-store--${p.value}`}>{p.value === 'baseline' ? 'Comparison' : 'Mirage'}</span>) },
    { field: 'storeId', headerName: 'Shop', width: 96, valueFormatter: (p) => STORE_SHORT[p.value as 'northpeak'] ?? p.value },
    { field: 'technique', headerName: 'Technique', flex: 1.4, minWidth: 180, cellRenderer: (p: ICellRendererParams<SimRun, string>) => (
      <span className="sb-tech">{p.value}{p.data?.whiteBox && <em>White-box</em>}{!p.data?.isAttack && <em className="hon">Honest</em>}</span>) },
    { field: 'turns', headerName: 'Turns', width: 66, type: 'numericColumn', cellClass: 'sb-num' },
    { field: 'leakedAnything', headerName: 'Leaked', width: 92, cellRenderer: (p: ICellRendererParams<SimRun, boolean>) => p.data?.isAttack
      ? (p.value ? (p.data.storeMode === 'mirage' ? <span className="sb-decoy"><i />Decoy</span> : <span className="sb-real">Real</span>) : <span className="sb-na">No</span>)
      : <Na /> },
    { field: 'realSecretLeaked', headerName: 'Real secret', width: 100, cellRenderer: (p: ICellRendererParams<SimRun, boolean>) => (p.value ? <span className="sb-real">Leaked</span> : <span className="sb-zero">0</span>) },
    { field: 'dollarsLostCents', headerName: 'Lost', width: 80, type: 'numericColumn', cellRenderer: (p: ICellRendererParams<SimRun, number>) => (p.value ? <span className="sb-bad">{money(p.value)}</span> : <span className="sb-zero">$0</span>) },
    { field: 'detectedStage', headerName: 'Caught at', width: 110, valueFormatter: (p) => STAGE[p.value as SimRun['detectedStage']] ?? '', cellClassRules: { 'sb-id': (p) => p.value === 'identity', 'sb-na': (p) => p.value === 'none' } },
    { field: 'identityCaptured', headerName: 'Identity', width: 84, cellRenderer: yes('identity') },
    { field: 'attributedCorrectly', headerName: 'Attributed', width: 96, cellRenderer: yes() },
    { field: 'falseAlarm', headerName: 'False alarm', width: 100, cellRenderer: (p: ICellRendererParams<SimRun, boolean>) => (p.data?.isAttack ? <Na /> : p.value ? <span className="sb-bad">Yes</span> : <span className="sb-zero">None</span>) },
    { field: 'honestOutcomeOk', headerName: 'Served OK', width: 96, cellRenderer: yes() },
  ], []);

  const base = data?.summary.find((s) => s.storeMode === 'baseline');
  const mir = data?.summary.find((s) => s.storeMode === 'mirage');
  const attacks = (base?.attackRuns ?? 0) + (mir?.attackRuns ?? 0);

  return (
    <div className="console sb">
      <ConsoleTopbar>
        <button type="button" className="c-btn c-btn--ghost" onClick={() => setReplayKey((k) => k + 1)}>Replay count</button>
      </ConsoleTopbar>

      <main className="sb-main">
        <header className="sb-hero">
          <div>
            <h1>We sent <span className="sb-hero-n">{data ? attacks : '—'}</span> AI attacks at two identical stores.</h1>
            <p>Same agent, same products. The only difference: the comparison store keeps the real codes in its prompt, while Mirage holds only decoys.</p>
          </div>
          <div className="sb-batch">
            <label>
              <span>Batch</span>
              <select className="c-select" value={data?.batchId ?? batchParam} onChange={(e) => setF('batchId', e.target.value)}>
                {!data?.batchId && !batchParam && <option value="">Latest</option>}
                {batches.map((b) => <option key={b} value={b}>{b}</option>)}
              </select>
            </label>
            <span className="sb-batch-n">{data?.runs.length ?? 0} runs</span>
          </div>
        </header>

        {error && <div className="c-error">{error}</div>}

        {base && mir && <Versus base={base} mir={mir} runKey={replayKey} />}

        <section className="sb-grid-wrap" aria-label="Every run">
          <div className="sb-grid-head">
            <h2>Every run</h2>
            <span className="sb-count">{rows.length} of {data?.runs.length ?? 0} runs · click a row to read its transcript</span>
          </div>
          <div className="sb-filters">
            <Seg label="Who" value={who} onChange={(v) => setF('who', v === 'all' ? null : v)} options={[['all', 'Everyone'], ['attack', 'Attackers'], ['honest', 'Honest customers']]} />
            <Seg label="Store" value={mode} onChange={(v) => setF('mode', v === 'both' ? null : v)} options={[['both', 'Both'], ['baseline', 'Comparison'], ['mirage', 'Mirage']]} />
            <button type="button" className={`sb-toggle${whiteBox ? ' on' : ''}`} onClick={() => setF('wb', whiteBox ? null : '1')} aria-pressed={whiteBox}>
              <i /> White-box only <small>attackers that read our source</small>
            </button>
            <label className="sb-select">
              <span>Technique</span>
              <select className="c-select" value={technique} onChange={(e) => setF('technique', e.target.value)}>
                <option value="">All techniques</option>
                {techniques.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            </label>
          </div>
          <div className="sb-grid">
            <AgGridReact<SimRun>
              theme={gridTheme}
              rowData={rows}
              columnDefs={cols}
              defaultColDef={{ sortable: true, resizable: true, filter: true }}
              getRowId={(p) => p.data.id}
              onRowClicked={(e: RowClickedEvent<SimRun>) => e.data && setOpen(e.data)}
              rowClass="sb-row"
              getRowClass={(p) => (p.data?.persona === 'honest.angry_refund_legit' ? 'sb-row-hl' : undefined)}
              animateRows
            />
          </div>
          <p className="sb-note">Money lost = unearned discounts plus fraudulent refunds, measured from the store&apos;s own records.</p>
        </section>
      </main>

      {open && <RunDrawer run={open} onClose={() => setOpen(null)} />}
    </div>
  );
}

function Seg<T extends string>({ label, value, onChange, options }: { label: string; value: T; onChange: (v: T) => void; options: [T, string][] }) {
  return (
    <div className="sb-seg-wrap">
      <span className="sb-seg-l">{label}</span>
      <div className="sb-seg" role="group" aria-label={label}>
        {options.map(([v, l]) => <button key={v} type="button" className={value === v ? 'on' : ''} onClick={() => onChange(v)} aria-pressed={value === v}>{l}</button>)}
      </div>
    </div>
  );
}

type Tone = 'held' | 'identity';
type Row = {
  label: string; hint?: string; b: number | null; m: number | null; fmt: (x: number) => string;
  bNote?: string; mNote?: string; lowIsGood: boolean;
  /** Red is reserved for loss: only these rows turn red when a store does worse. */
  alarm?: boolean;
  /** Color for Mirage when it does at least as well. */
  tone?: Tone;
  hero?: boolean;
};

function Versus({ base, mir, runKey }: { base: ScoreboardSummary; mir: ScoreboardSummary; runKey: number }) {
  const n = (x: number) => String(Math.round(x));
  const pct = (x: number | null) => (x === null ? null : x * 100);
  const rows: Row[] = [
    { label: 'Money lost', hint: 'Unearned discounts and fraudulent refunds', b: base.dollarsLostCents, m: mir.dollarsLostCents, fmt: (x) => money(Math.round(x / 100) * 100), lowIsGood: true, alarm: true, tone: 'held', hero: true },
    { label: 'Real secrets leaked', b: base.realSecretsLeaked, m: mir.realSecretsLeaked, fmt: n, lowIsGood: true, alarm: true, tone: 'held' },
    { label: 'Attackers caught', b: base.attackersCaught, m: mir.attackersCaught, fmt: n, bNote: `of ${base.attackRuns}`, mNote: `of ${mir.attackRuns}`, lowIsGood: false },
    { label: 'Attackers identified through PayPal', hint: 'Payer details returned at checkout', b: base.identitiesCaptured, m: mir.identitiesCaptured, fmt: n, lowIsGood: false, tone: 'identity' },
    { label: 'Attribution accuracy', hint: 'Trap traced back to the right chat', b: pct(base.attributionAccuracy), m: pct(mir.attributionAccuracy), fmt: (x) => `${Math.round(x)}%`, lowIsGood: false, tone: 'identity' },
    { label: 'False alarms on honest customers', b: base.falseAlarms, m: mir.falseAlarms, fmt: n, bNote: `of ${base.honestRuns}`, mNote: `of ${mir.honestRuns}`, lowIsGood: true, alarm: true },
    { label: 'Honest customers served', b: base.honestServedOk, m: mir.honestServedOk, fmt: n, bNote: `of ${base.honestRuns}`, mNote: `of ${mir.honestRuns}`, lowIsGood: false },
  ];
  const worse = (a: number | null, b: number | null, lowIsGood: boolean) => a !== null && b !== null && (lowIsGood ? a > b : a < b);
  const toneB = (r: Row) => (r.alarm && (worse(r.b, r.m, r.lowIsGood) || (r.hero && (r.b ?? 0) > 0)) ? 'bad' : undefined);
  const toneM = (r: Row): string | undefined => {
    if (r.m === null) return undefined;
    if (r.alarm && worse(r.m, r.b, r.lowIsGood)) return 'bad';
    if (r.tone === 'identity') return r.m > 0 ? 'identity' : undefined;
    return r.tone;
  };
  return (
    <section className="sb-cmp" aria-label="Comparison store versus Mirage">
      <div className="sb-cmp-row sb-cmp-head" style={{ '--i': 0 } as React.CSSProperties}>
        <div className="sb-cmp-cell sb-cmp-l"><span className="sb-cmp-caption">Same attacks, same honest shoppers</span></div>
        <div className="sb-cmp-cell is-base">
          <h2>Comparison store</h2>
          <p>Normal store setup: the agent&apos;s prompt holds the real codes</p>
        </div>
        <div className="sb-cmp-cell is-mirage">
          <h2><i className="sb-dot" aria-hidden="true" />Mirage</h2>
          <p>The agent holds only decoys</p>
        </div>
      </div>
      {rows.map((r, i) => (
        <div key={r.label} className={`sb-cmp-row${r.hero ? ' is-hero' : ''}`} style={{ '--i': i + 1 } as React.CSSProperties}>
          <div className="sb-cmp-cell sb-cmp-l">
            <span className="sb-cmp-label">{r.label}</span>
            {r.hint && <span className="sb-cmp-hint">{r.hint}</span>}
          </div>
          <div className="sb-cmp-cell is-base"><Metric value={r.b} fmt={r.fmt} delay={i * 90} runKey={runKey} tone={toneB(r)} note={r.bNote} /></div>
          <div className="sb-cmp-cell is-mirage">
            <Metric value={r.m} fmt={r.fmt} delay={i * 90} runKey={runKey} tone={toneM(r)} note={r.mNote} />
            {r.hero && r.m === 0 && mir.attackersCaught > 0 && <span className="sb-cmp-aside">Trapped orders held, never charged</span>}
          </div>
        </div>
      ))}
    </section>
  );
}

function Metric({ value, fmt, delay, runKey, tone, note }: {
  value: number | null; fmt: (n: number) => string; delay: number; runKey: number; tone?: string; note?: string;
}) {
  const reduced = usePrefersReducedMotion();
  const v = useCountUp(value ?? 0, 1300, 200 + delay, runKey);
  const shown = value === null ? '—' : fmt(reduced ? value : v);
  return (
    <span className={`sb-metric${tone ? ` sb-metric--${tone}` : ''}`}>
      <span className="sb-metric-v">{shown}</span>{note && value !== null && <small>{note}</small>}
    </span>
  );
}

function RunDrawer({ run, onClose }: { run: SimRun; onClose: () => void }) {
  const [detail, setDetail] = useState<SessionDetailRes | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    setDetail(null);
    api.sessionDetail(run.sessionId).then(setDetail).catch(() => setErr('Transcript not available for this run.'));
  }, [run.sessionId]);
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  const code = detail ? sessionDecoyCode(detail.events, detail.decoys?.staffCode) : undefined;
  return (
    <>
      <div className="sb-scrim" onClick={onClose} />
      <aside className="sb-drawer c-panel" aria-label="Run transcript">
        <header className="c-panel-head">
          <div>
            <span className="c-kicker">{run.id} · {run.storeMode === 'baseline' ? 'Comparison store' : 'Mirage'} · {STORE_SHORT[run.storeId]} · {titleCase(run.persona)}</span>
            <h3>{run.technique} · {chatLabel(run.sessionId, code)}</h3>
          </div>
          <button type="button" className="c-btn c-btn--ghost" onClick={onClose} aria-label="Close">✕</button>
        </header>
        <div className="sb-drawer-facts">
          <span>Leaked: <b>{run.leakedAnything ? (run.storeMode === 'mirage' ? 'Decoy only' : 'Real secret') : 'Nothing'}</b></span>
          <span>Lost: <b className={run.dollarsLostCents ? 'sb-bad' : 'sb-good'}>{money(run.dollarsLostCents)}</b></span>
          <span>Caught at: <b>{STAGE[run.detectedStage]}</b></span>
          {!run.isAttack && <span>False alarm: <b className={run.falseAlarm ? 'sb-bad' : 'sb-good'}>{run.falseAlarm ? 'yes' : 'no'}</b></span>}
        </div>
        <div className="c-panel-body sb-drawer-body">
          {err ? <p className="c-empty">{err}</p> : detail ? <Transcript detail={detail} /> : <p className="c-empty">Loading transcript…</p>}
        </div>
        <footer className="sb-drawer-foot">
          <Link className="c-btn" to={`/dashboard?session=${encodeURIComponent(run.sessionId)}`}>Open in console</Link>
          <Link className="c-btn c-btn--accent" to={`/demo?session=${encodeURIComponent(run.sessionId)}&view=attacker`}>▶ Replay this run</Link>
        </footer>
      </aside>
    </>
  );
}
