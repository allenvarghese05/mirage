// Rescore (no LLM calls): re-fetch every scored session of a batch file from the server, recompute each SimRun with
// the current metrics, rewrite data/sim-runs-<batch>.json and re-POST the runs (the server upserts by id).
// Identity fields are kept as stored; only derived metrics change. No import path to server/llm.ts (no LLM).
// Works on runner batch files ({ runs, records }) and network-scenario files ({ runs, leg1, leg2 }).
import { readFileSync, writeFileSync } from 'node:fs';
import type { ScoreboardSummary, SimRun } from '../shared/types';
import type { MirageApi } from './api';
import { computeSimRun } from './metrics';
import { networkRepeat, personaById, type Persona } from './personas';
import { summarize } from './summary';
import type { RunRecord } from './types';

export interface RunChange { id: string; sessionId: string; persona: string; fields: Record<string, [unknown, unknown]> }

export interface RescoreResult {
  file: string;
  before: ScoreboardSummary[];
  after: ScoreboardSummary[];
  changes: RunChange[];
  /** Runs kept as they were because their record or session could not be loaded. */
  kept: { id: string; reason: string }[];
  posted: { ok: boolean; status: number; error?: string };
}

/** Derived metrics: the only fields a rescore recomputes. */
const SCORED_FIELDS = [
  'leakedAnything', 'realSecretLeaked', 'dollarsLostCents', 'detectedStage', 'attributedCorrectly', 'identityCaptured',
  'falseAlarm', 'honestOutcomeOk',
] as const satisfies readonly (keyof SimRun)[];

function personaFor(id: string): Persona | undefined {
  if (id === 'attacker.network_repeat') return networkRepeat(personaById('honest.normal_shopper')!);
  return personaById(id);
}

export async function rescoreBatch(opts: { api: MirageApi; file: string; post?: boolean; log?: (l: string) => void }): Promise<RescoreResult> {
  const log = opts.log ?? ((l: string) => console.log(l));
  const data = JSON.parse(readFileSync(opts.file, 'utf8')) as {
    runs?: SimRun[]; records?: RunRecord[]; leg1?: RunRecord[]; leg2?: RunRecord; summary?: unknown; [k: string]: unknown;
  };
  const oldRuns = data.runs ?? [];
  const records = data.records ?? [...(data.leg1 ?? []), ...(data.leg2 ? [data.leg2] : [])];
  const byId = new Map(records.map((r) => [r.runId, r]));
  const newRuns: SimRun[] = [];
  const changes: RunChange[] = [];
  const kept: RescoreResult['kept'] = [];

  for (const old of oldRuns) {
    const rec = byId.get(old.id);
    if (!rec?.sessionId) { kept.push({ id: old.id, reason: 'no run record in file' }); newRuns.push(old); continue; }
    let run: SimRun;
    try {
      const detail = await opts.api.sessionDetail(rec.sessionId);
      run = computeSimRun(rec, detail, personaFor(rec.personaId));
    } catch (e) {
      kept.push({ id: old.id, reason: `session not available: ${(e as Error).message}` });
      newRuns.push(old);
      continue;
    }
    // Identity fields (id, batchId, createdAt, persona, storeMode, storeId, sessionId, whiteBox, technique, turns,
    // isAttack) stay exactly as stored; only the derived metrics come from the recomputation.
    const recomputed = run;
    run = { ...old };
    for (const k of SCORED_FIELDS) Object.assign(run, { [k]: recomputed[k] });
    const fields: RunChange['fields'] = {};
    for (const k of SCORED_FIELDS) if (old[k] !== run[k]) fields[k] = [old[k], run[k]];
    if (Object.keys(fields).length) changes.push({ id: run.id, sessionId: run.sessionId, persona: run.persona, fields });
    newRuns.push(run);
  }

  const before = summarize(oldRuns);
  const after = summarize(newRuns);
  const posted = opts.post === false || !newRuns.length
    ? { ok: false, status: 0, error: 'not posted' }
    : await opts.api.postSimRuns(newRuns);
  writeFileSync(opts.file, JSON.stringify({
    ...data, runs: newRuns, ...(data.summary !== undefined || data.records ? { summary: after } : {}),
    rescoredAt: new Date().toISOString(), rescorePosted: posted,
  }, null, 2));
  log(`rescored ${newRuns.length - kept.length}/${oldRuns.length} runs, ${changes.length} changed${kept.length ? `, ${kept.length} kept as-is` : ''}`);
  return { file: opts.file, before, after, changes, kept, posted };
}
