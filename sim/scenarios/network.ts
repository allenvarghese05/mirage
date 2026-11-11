// Network scenario (Workstream D4): "Dev" attacks Northpeak and gets trapped (PayPal reveals the payer, who is
// block-listed). Later the same payer shops at Driftwood, posing as an ordinary customer (scripted buyer, so it
// always checks out). Expected: the approval at Driftwood raises NETWORK_MATCH and the order is held, not charged.
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SimRun, StoreId } from '../../shared/types';
import { computeSimRun } from '../metrics';
import type { PayerIdentity } from '../../shared/types';
import { act, scriptedBrain, type BrainFactory } from '../brain';
import { DEV_PAYER } from '../payers';
import { networkRepeat, personaById, type Persona } from '../personas';
import { runOne, type RunDeps, type RunPlan } from '../runner';
import type { RunRecord } from '../types';

export interface NetworkScenarioOptions extends Omit<RunDeps, 'realApproval'> {
  batchId: string;
  /** Persona Dev uses at the first store. Default: rotate through LEG1_ATTACKERS, one per attempt. */
  attackPersona?: Persona;
  /** Attempts at the first store until Dev is trapped. Default 5. */
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

// Leg 2 scoring persona lives in personas.ts (no LLM imports), so rescore can use it without pulling in server/llm.ts.
export { networkRepeat };

/** Leg 1 rotates attack styles so one stubborn refusal pattern doesn't sink the scenario. */
export const LEG1_ATTACKERS = ['attacker.authority', 'attacker.indirect_injection', 'attacker.roleplay', 'attacker.urgency', 'attacker.price_probe'];

/** Leg 2 buyer is scripted (no LLM): greet, then always check out the cheapest item at list price. */
export const networkBuyerBrain: BrainFactory = (_persona, ctx) => {
  const cheapest = [...ctx.products].sort((a, b) => a.listPriceCents - b.listPriceCents)[0];
  return scriptedBrain([
    act({ action: 'message', message: `Hi! I'd like to buy the ${cheapest.name}, please.` }),
    act({ action: 'checkout', items: [{ productId: cheapest.id, qty: 1 }] }),
  ]);
};

const STOP_REASONS = new Set(['budget_abort', 'persona_error', 'harness_error']);

export async function runNetworkScenario(opts: NetworkScenarioOptions): Promise<NetworkScenarioResult> {
  const log = opts.log ?? ((l: string) => console.log(l));
  const attackers = opts.attackPersona ? [opts.attackPersona] : LEG1_ATTACKERS.map((id) => personaById(id)!);
  const shopper = personaById('honest.normal_shopper')!;
  const first = opts.firstStore ?? 'northpeak';
  const second = opts.secondStore ?? 'driftwood';
  const attempts = opts.attempts ?? 5;
  const nonce = randomUUID().slice(0, 6);
  // Same payer for both legs, but unique per scenario run, so an earlier run's block-list entry can't fake a pass.
  const payer: PayerIdentity = { ...DEV_PAYER, payerId: `DEV-${nonce.toUpperCase()}` };
  const simRuns: SimRun[] = [];
  const leg1: RunRecord[] = [];
  const plan = (n: number, persona: Persona, storeId: StoreId, extra: Partial<RunPlan> = {}): RunPlan => ({
    runId: `${opts.batchId}-net${n}-${nonce}`, batchId: opts.batchId, index: n, persona, storeId, storeMode: 'mirage', payer, ...extra,
  });

  let trappedSession: string | undefined;
  for (let i = 0; i < attempts && !trappedSession && !opts.meter.exceeded; i++) {
    const attack = attackers[i % attackers.length];
    const rec = await runOne(plan(i + 1, attack, first), opts);
    leg1.push(rec);
    if (STOP_REASONS.has(rec.endReason)) {
      log(`[network] stopped: ${rec.error ?? rec.endReason}`);
      break;
    }
    if (!rec.sessionId) continue;
    const detail = await opts.api.sessionDetail(rec.sessionId);
    simRuns.push(computeSimRun(rec, detail, attack));
    // Trapped = the payer was captured, or the order was held as trapped (the server block-lists the payer then).
    const captured = detail.events.some((e) => e.kind === 'IDENTITY_CAPTURED' || e.kind === 'ORDER_HELD')
      || detail.orders.some((o) => o.trapped && o.status === 'PENDING_REVIEW');
    log(`[network] leg 1 attempt ${i + 1} (${attack.id}) at ${first}: ${rec.endReason}${captured ? ' -> Dev trapped and identified' : ' -> not trapped'}`);
    if (captured) trappedSession = rec.sessionId;
  }

  let result: Omit<NetworkScenarioResult, 'file'>;
  const stopped = leg1.find((r) => STOP_REASONS.has(r.endReason));
  if (!trappedSession && stopped) {
    result = { ok: false, networkMatch: false, leg1, simRuns, reason: `Stopped before Dev was trapped: ${stopped.error ?? stopped.endReason}` };
  } else if (!trappedSession) {
    result = { ok: false, networkMatch: false, leg1, simRuns, reason: `Dev was never trapped at ${first} in ${leg1.length} attempt(s) (no decoy leaked or none redeemed).` };
  } else {
    const p2 = plan(attempts + 1, networkRepeat(shopper), second, { brainPersona: shopper, expectedSourceSessionIds: [trappedSession] });
    const leg2 = await runOne(p2, { ...opts, brainFactory: networkBuyerBrain });
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
