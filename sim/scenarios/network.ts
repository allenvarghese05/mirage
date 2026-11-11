// Network scenario (Workstream D4): "Dev" attacks Northpeak and gets trapped (PayPal reveals the payer, who is
// block-listed). Later the same payer shops at Driftwood, posing as an ordinary customer. Expected: the approval
// at Driftwood raises NETWORK_MATCH and the order is held, not charged.
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SimRun, StoreId } from '../../shared/types';
import { computeSimRun } from '../metrics';
import { DEV_PAYER } from '../payers';
import { personaById, type Persona } from '../personas';
import { runOne, type RunDeps, type RunPlan } from '../runner';
import type { RunRecord } from '../types';

export interface NetworkScenarioOptions extends Omit<RunDeps, 'realApproval'> {
  batchId: string;
  /** Persona Dev uses at the first store. Default attacker.authority. */
  attackPersona?: Persona;
  /** Attempts at the first store until Dev is trapped. Default 3. */
  attempts?: number;
  firstStore?: StoreId;
  secondStore?: StoreId;
  outDir?: string;
  post?: boolean;
}

export interface NetworkScenarioResult {
  ok: boolean;
  reason: string;
  networkMatch: boolean;
  leg1: RunRecord[];
  leg2?: RunRecord;
  simRuns: SimRun[];
  file: string;
}

/** How leg 2 is scored: an attack (the payer is a known attacker), even though Dev behaves like a normal shopper. */
const networkRepeat = (shopper: Persona): Persona => ({
  ...shopper,
  id: 'attacker.network_repeat',
  kind: 'attacker',
  technique: 'Network: known attacker at a second store',
  expectedOutcome: undefined,
});

export async function runNetworkScenario(opts: NetworkScenarioOptions): Promise<NetworkScenarioResult> {
  const log = opts.log ?? ((l: string) => console.log(l));
  const attack = opts.attackPersona ?? personaById('attacker.authority')!;
  const shopper = personaById('honest.normal_shopper')!;
  const first = opts.firstStore ?? 'northpeak';
  const second = opts.secondStore ?? 'driftwood';
  const attempts = opts.attempts ?? 3;
  const nonce = randomUUID().slice(0, 6);
  const simRuns: SimRun[] = [];
  const leg1: RunRecord[] = [];
  const plan = (n: number, persona: Persona, storeId: StoreId, extra: Partial<RunPlan> = {}): RunPlan => ({
    runId: `${opts.batchId}-net${n}-${nonce}`, batchId: opts.batchId, index: n, persona, storeId, storeMode: 'mirage', payer: DEV_PAYER, ...extra,
  });

  let trappedSession: string | undefined;
  for (let i = 0; i < attempts && !trappedSession && !opts.meter.exceeded; i++) {
    const rec = await runOne(plan(i + 1, attack, first), opts);
    leg1.push(rec);
    if (rec.endReason === 'budget_abort' || rec.endReason === 'persona_error') {
      log(`[network] stopped: ${rec.error ?? rec.endReason}`);
      break;
    }
    if (!rec.sessionId) continue;
    const detail = await opts.api.sessionDetail(rec.sessionId);
    simRuns.push(computeSimRun(rec, detail, attack));
    const captured = detail.identity?.payerId === DEV_PAYER.payerId || detail.events.some((e) => e.kind === 'IDENTITY_CAPTURED');
    log(`[network] leg 1 attempt ${i + 1} at ${first}: ${rec.endReason}${captured ? ' -> Dev trapped and identified' : ' -> not trapped'}`);
    if (captured) trappedSession = rec.sessionId;
  }

  let result: Omit<NetworkScenarioResult, 'file'>;
  const stopped = leg1.find((r) => r.endReason === 'budget_abort' || r.endReason === 'persona_error');
  if (!trappedSession && stopped) {
    result = { ok: false, networkMatch: false, leg1, simRuns, reason: `Stopped before Dev was trapped: ${stopped.error ?? stopped.endReason}` };
  } else if (!trappedSession) {
    result = { ok: false, networkMatch: false, leg1, simRuns, reason: `Dev was never trapped at ${first} in ${leg1.length} attempt(s) (no decoy leaked or none redeemed).` };
  } else {
    const p2 = plan(attempts + 1, networkRepeat(shopper), second, { brainPersona: shopper, expectedSourceSessionIds: [trappedSession] });
    const leg2 = await runOne(p2, opts);
    let networkMatch = false;
    if (leg2.sessionId) {
      const detail = await opts.api.sessionDetail(leg2.sessionId);
      simRuns.push(computeSimRun(leg2, detail, p2.persona));
      networkMatch = detail.events.some((e) => e.kind === 'NETWORK_MATCH');
    }
    const status = leg2.checkout?.approved?.status;
    const held = status === 'PENDING_REVIEW';
    log(`[network] leg 2 at ${second}: ${leg2.endReason}${status ? ` ${status}` : ''} networkMatch=${networkMatch}`);
    const ok = networkMatch && held;
    result = {
      ok, networkMatch, leg1, leg2, simRuns,
      reason: ok ? `NETWORK_MATCH at ${second}; order held, not charged.`
        : !leg2.checkout ? `Dev did not check out at ${second} (${leg2.endReason}).`
          : `Expected NETWORK_MATCH and a held order at ${second}; got networkMatch=${networkMatch}, status=${status ?? leg2.checkout.error}.`,
    };
  }

  const outDir = opts.outDir ?? 'data';
  const file = join(outDir, `sim-runs-${opts.batchId}.json`);
  const posted = opts.post === false || !simRuns.length ? { ok: false, status: 0, error: 'not posted' } : await opts.api.postSimRuns(simRuns);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(file, JSON.stringify({ scenario: 'network', batchId: opts.batchId, ...result, posted, runs: simRuns, writtenAt: new Date().toISOString() }, null, 2));
  log(`[network] ${result.ok ? 'PASS' : 'FAIL'}: ${result.reason}`);
  return { ...result, file };
}
