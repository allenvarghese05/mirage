import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { AgGridReact } from 'ag-grid-react';
import {
  AllCommunityModule, ModuleRegistry, colorSchemeDark, themeQuartz, type ColDef, type ICellRendererParams, type RowClickedEvent,
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

const gridTheme = themeQuartz.withPart(colorSchemeDark).withParams({
  backgroundColor: '#0a0e13',
  foregroundColor: '#d5dde5',
  headerBackgroundColor: '#080b10',
  headerTextColor: '#6e7d8b',
  borderColor: '#1a232d',
  accentColor: '#35f0c4',
  rowHoverColor: 'rgba(53, 240, 196, 0.06)',
  selectedRowBackgroundColor: 'rgba(53, 240, 196, 0.1)',
  oddRowBackgroundColor: '#0c1016',
  fontFamily: "'JetBrains Mono', ui-monospace, monospace",
  headerFontFamily: "'Archivo', sans-serif",
  headerFontWeight: 700,
  fontSize: 12.5,
  rowHeight: 38,
  headerHeight: 40,
  wrapperBorderRadius: 10,
});

type Who = 'all' | 'attack' | 'honest';
type ModeF = 'both' | 'baseline' | 'mirage';

const STAGE: Record<SimRun['detectedStage'], string> = {
  none: '—', chat_attempt: 'chat · attempt', chat_leak: 'chat · leak', honey_tool: 'honey tool', checkout: 'checkout', identity: 'identity ✓',
};

function Pill({ v, kind }: { v: string; kind: string }) { return <span className={`sb-pill sb-${kind}`}>{v}</span>; }
const yes = (good: boolean) => (p: ICellRendererParams<SimRun, boolean | null>) =>
  p.value === null || p.value === undefined ? <span className="sb-na">—</span> : p.value ? <span className={good ? 'sb-good' : 'sb-bad'}>✓</span> : <span className="sb-na">✗</span>;

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
  const setF = (k: string, v: string | null) => setParams((p) => { const n = new URLSearchParams(p); if (v === null || v === '') n.delete(k); else n.set(k, v); return n; }, { replace: true });

  useEffect(() => {
    document.title = 'Mirage · Scoreboard';
    api.scoreboard().then(setData).catch(() => setError('Cannot load the scoreboard. Is the server running? (Or add ?mock=1)'));
  }, []);

  const rows = useMemo(() => (data?.runs ?? []).filter((r) =>
    (who === 'all' || (who === 'attack' ? r.isAttack : !r.isAttack)) &&
    (mode === 'both' || r.storeMode === mode) &&
    (!whiteBox || r.whiteBox) &&
    (!technique || r.technique === technique)), [data, who, mode, whiteBox, technique]);
  const techniques = useMemo(() => [...new Set((data?.runs ?? []).map((r) => r.technique))].sort(), [data]);

  const cols = useMemo<ColDef<SimRun>[]>(() => [
    { field: 'id', headerName: 'Run', width: 96, pinned: 'left' },
    { field: 'storeMode', headerName: 'Store', width: 120, cellRenderer: (p: ICellRendererParams<SimRun, string>) => <Pill v={p.value === 'baseline' ? 'normal' : 'mirage'} kind={p.value ?? ''} /> },
    { field: 'storeId', headerName: 'Shop', width: 110, valueFormatter: (p) => STORE_SHORT[p.value as 'northpeak'] ?? p.value },
    { field: 'technique', headerName: 'Technique', flex: 1.4, minWidth: 190, cellRenderer: (p: ICellRendererParams<SimRun, string>) => (
      <span className="sb-tech">{p.data?.whiteBox && <em>WB</em>}{!p.data?.isAttack && <em className="hon">HONEST</em>}{p.value}</span>) },
    { field: 'turns', headerName: 'Turns', width: 84, type: 'numericColumn' },
    { field: 'leakedAnything', headerName: 'Leaked', width: 96, cellRenderer: (p: ICellRendererParams<SimRun, boolean>) => p.data?.isAttack ? (p.value ? <span className={p.data.storeMode === 'mirage' ? 'sb-decoy' : 'sb-bad'}>{p.data.storeMode === 'mirage' ? 'decoy' : 'REAL'}</span> : <span className="sb-na">no</span>) : <span className="sb-na">—</span> },
    { field: 'realSecretLeaked', headerName: 'Real secret', width: 112, cellRenderer: (p: ICellRendererParams<SimRun, boolean>) => (p.value ? <span className="sb-bad">LEAKED</span> : <span className="sb-good">0</span>) },
    { field: 'dollarsLostCents', headerName: '$ lost', width: 104, type: 'numericColumn', cellRenderer: (p: ICellRendererParams<SimRun, number>) => (p.value ? <span className="sb-bad">{money(p.value)}</span> : <span className="sb-good">$0</span>) },
    { field: 'detectedStage', headerName: 'Caught at', width: 132, valueFormatter: (p) => STAGE[p.value as SimRun['detectedStage']] ?? '' , cellClassRules: { 'sb-id': (p) => p.value === 'identity' } },
    { field: 'identityCaptured', headerName: 'Identity', width: 100, cellRenderer: yes(true) },
    { field: 'attributedCorrectly', headerName: 'Attributed', width: 112, cellRenderer: yes(true) },
    { field: 'falseAlarm', headerName: 'False alarm', width: 116, cellRenderer: (p: ICellRendererParams<SimRun, boolean>) => (p.data?.isAttack ? <span className="sb-na">—</span> : p.value ? <span className="sb-bad">yes</span> : <span className="sb-good">none</span>) },
    { field: 'honestOutcomeOk', headerName: 'Served OK', width: 112, cellRenderer: yes(true) },
  ], []);

  const base = data?.summary.find((s) => s.storeMode === 'baseline');
  const mir = data?.summary.find((s) => s.storeMode === 'mirage');
  const attackers = (base?.attackRuns ?? 0) + (mir?.attackRuns ?? 0);

  return (
    <div className="console sb">
      <ConsoleTopbar>
        <span className="sb-batch mono">batch {data?.batchId ?? '—'} · {data?.runs.length ?? 0} runs</span>
        <button type="button" className="c-btn c-btn--ghost" onClick={() => setReplayKey((k) => k + 1)}>↻ Replay count</button>
      </ConsoleTopbar>

      <main className="sb-main">
        <header className="sb-hero">
          <p className="c-kicker">Proof · simulated attacks against two identical stores</p>
          <h1>We sent <b>{attackers}</b> AI attackers at two identical stores.<br /><span>One normal. One running Mirage.</span></h1>
        </header>

        {error && <div className="c-error">{error}</div>}

        {base && mir && <Versus base={base} mir={mir} runKey={replayKey} />}

        <section className="sb-grid-wrap">
          <div className="sb-filters">
            <Seg label="Who" value={who} onChange={(v) => setF('who', v === 'all' ? null : v)} options={[['all', 'Everyone'], ['attack', 'Attackers'], ['honest', 'Honest customers']]} />
            <Seg label="Store" value={mode} onChange={(v) => setF('mode', v === 'both' ? null : v)} options={[['both', 'Both'], ['baseline', 'Normal'], ['mirage', 'Mirage']]} />
            <button type="button" className={`sb-toggle${whiteBox ? ' on' : ''}`} onClick={() => setF('wb', whiteBox ? null : '1')} aria-pressed={whiteBox}>
              <i /> White-box only <small>attackers that read our source</small>
            </button>
            <label className="sb-select">
              <span>Technique</span>
              <select value={technique} onChange={(e) => setF('technique', e.target.value)}>
                <option value="">All techniques</option>
                {techniques.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            </label>
            <span className="sb-count mono">{rows.length} rows</span>
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
          <p className="sb-note">Click any row to read its transcript. Dollars lost = unearned discounts + fraudulent refunds, measured from the store&apos;s own records.</p>
        </section>
      </main>

      {open && <RunDrawer run={open} onClose={() => setOpen(null)} />}
    </div>
  );
}

function Seg<T extends string>({ label, value, onChange, options }: { label: string; value: T; onChange: (v: T) => void; options: [T, string][] }) {
  return (
    <div className="sb-seg" role="group" aria-label={label}>
      <span>{label}</span>
      {options.map(([v, l]) => <button key={v} type="button" className={value === v ? 'on' : ''} onClick={() => onChange(v)} aria-pressed={value === v}>{l}</button>)}
    </div>
  );
}

function Versus({ base, mir, runKey }: { base: ScoreboardSummary; mir: ScoreboardSummary; runKey: number }) {
  const n = (x: number) => String(Math.round(x));
  type Row = { label: string; b: number | null; m: number | null; fmt: (x: number) => string; bNote?: string; mNote?: string; lowIsGood: boolean };
  const rows: Row[] = [
    { label: 'Dollars lost', b: base.dollarsLostCents, m: mir.dollarsLostCents, fmt: (x) => money(Math.round(x / 100) * 100), lowIsGood: true },
    { label: 'Real secrets leaked', b: base.realSecretsLeaked, m: mir.realSecretsLeaked, fmt: n, lowIsGood: true },
    { label: 'Attackers caught', b: base.attackersCaught, m: mir.attackersCaught, fmt: n, bNote: `of ${base.attackRuns}`, mNote: `of ${mir.attackRuns}`, lowIsGood: false },
    { label: 'Attackers identified via PayPal', b: base.identitiesCaptured, m: mir.identitiesCaptured, fmt: n, lowIsGood: false },
    { label: 'Attribution accuracy', b: base.attributionAccuracy === null ? null : base.attributionAccuracy * 100, m: mir.attributionAccuracy === null ? null : mir.attributionAccuracy * 100, fmt: (x) => `${Math.round(x)}%`, lowIsGood: false },
    { label: 'False alarms on honest customers', b: base.falseAlarms, m: mir.falseAlarms, fmt: n, bNote: `of ${base.honestRuns}`, mNote: `of ${mir.honestRuns}`, lowIsGood: true },
    { label: 'Honest customers served', b: base.honestServedOk, m: mir.honestServedOk, fmt: n, bNote: `of ${base.honestRuns}`, mNote: `of ${mir.honestRuns}`, lowIsGood: false },
  ];
  const worse = (r: Row) => r.b !== null && r.m !== null && (r.lowIsGood ? r.b > r.m : r.b < r.m);
  return (
    <section className="sb-versus" aria-label="Normal store versus Mirage">
      <div className="sb-tile sb-tile--base">
        <header><span className="sb-tile-k">Normal store</span><b>Agent holds the real secrets</b></header>
        {rows.map((r, i) => <Metric key={r.label} label={r.label} value={r.b} fmt={r.fmt} delay={i * 120} runKey={runKey} tone={worse(r) ? 'bad' : 'neutral'} note={r.bNote} />)}
      </div>
      <div className="sb-vs" aria-hidden="true">VS</div>
      <div className="sb-tile sb-tile--mirage">
        <header><span className="sb-tile-k">Mirage</span><b>Agent holds only traps</b></header>
        {rows.map((r, i) => <Metric key={r.label} label={r.label} value={r.m} fmt={r.fmt} delay={i * 120} runKey={runKey} tone="good" note={r.mNote} />)}
      </div>
    </section>
  );
}

function Metric({ label, value, fmt, delay, runKey, tone, note }: {
  label: string; value: number | null; fmt: (n: number) => string; delay: number; runKey: number; tone: string; note?: string;
}) {
  const v = useCountUp(value ?? 0, 1500, 250 + delay, runKey);
  const display = value === null ? '—' : undefined;
  return (
    <div className={`sb-metric sb-metric--${tone}`}>
      <span className="sb-metric-l">{label}</span>
      <span className="sb-metric-v">{display ?? fmt(v)}{note && <small> {note}</small>}</span>
    </div>
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
            <span className="c-kicker">{run.id} · {run.storeMode === 'baseline' ? 'normal store' : 'mirage'} · {STORE_SHORT[run.storeId]} · {titleCase(run.persona)}</span>
            <h3>{run.technique} · {chatLabel(run.sessionId, code)}</h3>
          </div>
          <button type="button" className="c-btn c-btn--ghost" onClick={onClose} aria-label="Close">✕</button>
        </header>
        <div className="sb-drawer-facts">
          <span>Leaked: <b>{run.leakedAnything ? (run.storeMode === 'mirage' ? 'decoy only' : 'REAL secret') : 'nothing'}</b></span>
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
