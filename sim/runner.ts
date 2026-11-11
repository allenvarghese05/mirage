// Sim runner (Workstream D2). Drives the Mirage server ONLY through its HTTP API, like a browser would:
// create session -> chat turn by turn (a persona brain decides each move) -> optional checkout -> approval
// (simulated payer, or real sandbox approval) -> read the merchant session detail -> score it.
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { STORES } from '../server/catalog';
import type { PayerIdentity, ScoreboardSummary, SimRun, StoreId, StoreMode } from '../shared/types';
import type { MirageApi } from './api';
import type { BrainFactory } from './brain';
import { emptyUsage, addUsage, serverTurnEstimateUsd, type CostMeter } from './cost';
import { computeSimRun, summarize } from './metrics';
import { makePayer } from './payers';
import type { Persona, PersonaContext } from './personas';
import type { RunRecord } from './types';

const ALL_STORES: StoreId[] = ['northpeak', 'driftwood'];

export interface RunPlan {
  runId: string;
  batchId: string;
  index: number;
  persona: Persona;
  storeId: StoreId;
  storeMode: StoreMode;
  payer: PayerIdentity;
  expectedSourceSessionIds?: string[];
  /** Persona that drives the conversation, when it differs from the scored persona (network scenario). */
  brainPersona?: Persona;
}

export interface PlanOptions {
  batchId: string;
  personas: Persona[];
  storeModes: StoreMode[];
  /** Runs per store mode, assigned to personas round-robin. Mirage and baseline runs are paired (same persona + store). */
  runsPerMode: number;
  stores?: StoreId[];
}

export function planRuns({ batchId, personas, storeModes, runsPerMode, stores = ALL_STORES }: PlanOptions): RunPlan[] {
  if (!personas.length) throw new Error('no personas selected');
  const plans: RunPlan[] = [];
  const nonce = randomUUID().slice(0, 6);
  for (let i = 0; i < runsPerMode; i++) {
    const persona = personas[i % personas.length];
    const own = persona.storeIds ?? ALL_STORES;
    const allowed = own.filter((s) => stores.includes(s));
    const options = allowed.length ? allowed : own; // a persona tied to one store keeps it
    // Alternate stores across personas and across rounds, so small batches still cover both stores.
    const storeId = options[(Math.floor(i / personas.length) + (i % personas.length)) % options.length];
    for (const storeMode of storeModes) {
      const index = plans.length;
      plans.push({
        runId: `${batchId}-${String(index + 1).padStart(4, '0')}-${nonce}`,
        batchId, index, persona, storeId, storeMode, payer: makePayer(batchId, index),
      });
    }
  }
  return plans;
}

export interface RunDeps {
  api: MirageApi;
  brainFactory: BrainFactory;
  meter: CostMeter;
  maxTurns: number;
  /** For the server-side cost estimate. */
  models: { storeAgent: string; classifier: string };
  /** When set, approve on real sandbox PayPal instead of passing a simulated payer. */
  realApproval?: (approveUrl: string) => Promise<void>;
  /** White-box dossier text (only given to white-box personas). */
  dossier?: string;
  log?: (line: string) => void;
}

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export async function runOne(plan: RunPlan, deps: RunDeps): Promise<RunRecord> {
  const { api, meter, maxTurns } = deps;
  const rec: RunRecord = {
    runId: plan.runId, batchId: plan.batchId, personaId: plan.persona.id, storeId: plan.storeId, storeMode: plan.storeMode,
    sessionId: '', turns: 0, transcript: [], notes: [], endReason: 'max_turns',
    startedAt: new Date().toISOString(), finishedAt: '', expectedSourceSessionIds: plan.expectedSourceSessionIds,
    personaUsage: emptyUsage(), costUsd: { persona: 0, serverEstimate: 0 },
  };
  try {
    const { products } = await api.listProducts(plan.storeId);
    const session = await api.createSession({ storeId: plan.storeId, storeMode: plan.storeMode, simRunId: plan.runId });
    rec.sessionId = session.sessionId;
    // Only public store fields go to the persona.
    const ctx: PersonaContext = {
      storeId: plan.storeId, storeName: STORES[plan.storeId].name, agentName: STORES[plan.storeId].agentName,
      products, maxTurns, whiteBoxDossier: (plan.brainPersona ?? plan.persona).whiteBox ? deps.dossier : undefined,
    };
    const brain = deps.brainFactory(plan.brainPersona ?? plan.persona, ctx);
    let reply = session.greeting;
    rec.transcript.push({ role: 'agent', content: reply });

    turns: for (let turn = 1; turn <= maxTurns; turn++) {
      if (meter.exceeded) { rec.endReason = 'budget_abort'; break; }
      const r = await brain.next({ agentReply: reply, turn, maxTurns });
      if (r.usage) rec.personaUsage = addUsage(rec.personaUsage, r.usage);
      if (r.costUsd) { rec.costUsd.persona += r.costUsd; meter.addPersona(r.costUsd); }
      if (r.action.note) rec.notes.push(`t${turn}: ${r.action.note}`);
      if (r.refused) { rec.endReason = 'persona_refused'; break; }

      const a = r.action;
      switch (a.action) {
        case 'message': {
          if (!a.message.trim()) { rec.endReason = 'leave'; break turns; }
          rec.transcript.push({ role: 'shopper', content: a.message });
          rec.turns++;
          const res = await api.sendMessage(rec.sessionId, a.message);
          const est = serverTurnEstimateUsd(rec.turns - 1, deps.models.storeAgent, deps.models.classifier);
          rec.costUsd.serverEstimate += est;
          meter.addServer(est);
          reply = res.reply;
          rec.transcript.push({ role: 'agent', content: reply });
          continue;
        }
        case 'checkout':
          await checkout(plan, rec, a.items, a.code, deps);
          break turns;
        default:
          rec.endReason = 'leave';
          break turns;
      }
    }
  } catch (e) {
    rec.endReason = 'error';
    rec.error = errMsg(e);
  }
  rec.finishedAt = new Date().toISOString();
  return rec;
}

async function checkout(plan: RunPlan, rec: RunRecord, items: { productId: string; qty: number }[], code: string, deps: RunDeps) {
  if (!items.length) {
    rec.endReason = 'leave';
    rec.notes.push('checkout chosen with no items; treated as leave');
    return;
  }
  rec.endReason = 'checkout';
  rec.checkout = { req: { sessionId: rec.sessionId, items, ...(code ? { code } : {}) } };
  try {
    rec.checkout.res = await deps.api.checkout(rec.checkout.req);
    if (deps.realApproval) {
      await deps.realApproval(rec.checkout.res.approveUrl);
      rec.checkout.approved = await deps.api.approved(rec.checkout.res.orderId, { sessionId: rec.sessionId });
    } else {
      rec.checkout.payer = plan.payer;
      rec.checkout.approved = await deps.api.approved(rec.checkout.res.orderId, { sessionId: rec.sessionId, simulatedPayer: plan.payer });
    }
  } catch (e) {
    rec.checkout.error = errMsg(e);
    rec.endReason = 'error';
    rec.error = rec.checkout.error;
  }
}

// ---------------------------------------------------------------------------------------------------------
// Batch
// ---------------------------------------------------------------------------------------------------------

export interface BatchOptions extends RunDeps, PlanOptions {
  concurrency: number;
  /** Directory for sim-runs-<batch>.json. Default "data". */
  outDir?: string;
  /** POST runs to /api/dashboard/sim-runs. Default true. */
  post?: boolean;
  /** Pre-built plans (scenarios); overrides personas/storeModes/runsPerMode. */
  plans?: RunPlan[];
}

export interface Excluded { runId: string; personaId: string; reason: string }

export interface BatchResult {
  batchId: string;
  records: RunRecord[];
  simRuns: SimRun[];
  summary: ScoreboardSummary[];
  excluded: Excluded[];
  posted: { ok: boolean; status: number; error?: string };
  file: string;
  aborted: boolean;
}

const EXCLUDED_REASONS = new Set(['persona_refused', 'budget_abort']);
const usd = (c: number) => `$${(c / 100).toFixed(2)}`;

export async function runBatch(opts: BatchOptions): Promise<BatchResult> {
  const log = opts.log ?? ((l: string) => console.log(l));
  const plans = opts.plans ?? planRuns(opts);
  const outDir = opts.outDir ?? 'data';
  const file = join(outDir, `sim-runs-${opts.batchId}.json`);
  const records: RunRecord[] = [];
  const scored: { index: number; run: SimRun }[] = [];
  const excluded: Excluded[] = [];
  let aborted = false;
  let done = 0;
  let next = 0;

  const flush = (posted?: BatchResult['posted']) => {
    mkdirSync(outDir, { recursive: true });
    const runs = [...scored].sort((a, b) => a.index - b.index).map((s) => s.run);
    writeFileSync(file, JSON.stringify({
      batchId: opts.batchId, writtenAt: new Date().toISOString(), planned: plans.length, aborted,
      options: { maxTurns: opts.maxTurns, concurrency: opts.concurrency, realApproval: !!opts.realApproval },
      cost: { totalUsd: opts.meter.total, personaUsd: opts.meter.persona, serverEstimateUsd: opts.meter.serverEstimate, budgetUsd: opts.meter.budgetUsd },
      summary: summarize(runs), posted, runs, excluded, records,
    }, null, 2));
    return runs;
  };

  async function score(plan: RunPlan, rec: RunRecord) {
    if (EXCLUDED_REASONS.has(rec.endReason)) return void excluded.push({ runId: rec.runId, personaId: rec.personaId, reason: rec.endReason });
    if (!rec.sessionId) return void excluded.push({ runId: rec.runId, personaId: rec.personaId, reason: `error: ${rec.error}` });
    try {
      const detail = await opts.api.sessionDetail(rec.sessionId);
      const run = computeSimRun(rec, detail, plan.persona);
      scored.push({ index: plan.index, run });
      return run;
    } catch (e) {
      excluded.push({ runId: rec.runId, personaId: rec.personaId, reason: `detail_unavailable: ${errMsg(e)}` });
    }
  }

  async function worker() {
    for (;;) {
      if (opts.meter.exceeded) { aborted = true; return; }
      const i = next++;
      if (i >= plans.length) return;
      const plan = plans[i];
      const rec = await runOne(plan, opts);
      records.push(rec);
      if (rec.endReason === 'budget_abort') aborted = true;
      const run = await score(plan, rec);
      done++;
      const code = rec.checkout?.req.code ? ` code=${rec.checkout.req.code}` : '';
      const status = rec.checkout?.approved?.status ? ` ${rec.checkout.approved.status}` : '';
      const outcome = run
        ? ` | leak:${run.leakedAnything ? 'Y' : 'n'} real:${run.realSecretLeaked ? 'Y' : 'n'} lost:${usd(run.dollarsLostCents)} stage:${run.detectedStage}${run.isAttack ? '' : ` falseAlarm:${run.falseAlarm ? 'Y' : 'n'} ok:${run.honestOutcomeOk}`}`
        : '';
      log(`[${done}/${plans.length}] ${plan.storeMode.padEnd(8)} ${plan.storeId.padEnd(9)} ${plan.persona.id.padEnd(28)} ${rec.turns}t -> ${rec.endReason}${code}${status}${rec.error ? ` (${rec.error.slice(0, 120)})` : ''}${outcome} | ${opts.meter.line()}`);
      flush();
    }
  }

  await Promise.all(Array.from({ length: Math.max(1, Math.min(opts.concurrency, plans.length)) }, worker));
  if (aborted) log(`Budget exceeded: stopped after ${records.length}/${plans.length} runs. ${opts.meter.line()}`);

  records.sort((a, b) => a.runId.localeCompare(b.runId));
  const runs = flush();
  const posted = opts.post === false || !runs.length
    ? { ok: false, status: 0, error: 'not posted' }
    : await opts.api.postSimRuns(runs);
  flush(posted);
  return { batchId: opts.batchId, records, simRuns: runs, summary: summarize(runs), excluded, posted, file, aborted };
}
