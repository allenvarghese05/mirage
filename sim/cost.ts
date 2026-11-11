// Cost guard (Workstream D). Persona-side LLM spend is measured from API usage; the store agent's spend happens
// inside the server and is not visible over HTTP, so it is ESTIMATED per turn. Pricing is server/llm.ts costOf,
// the same function the shared spend ledger uses, so sim numbers match the ledger.
import { costOf } from '../server/llm';
import type { TokenUsage } from './types';

export const emptyUsage = (): TokenUsage => ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });

export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
  };
}

/** Same pricing as the shared spend ledger (server/llm.ts costOf), so sim numbers match the ledger. */
export function usageCostUsd(model: string, u: TokenUsage): number {
  return costOf(model, {
    input_tokens: u.inputTokens,
    output_tokens: u.outputTokens,
    cache_read_input_tokens: u.cacheReadTokens,
    cache_creation_input_tokens: u.cacheWriteTokens,
  });
}

/** Assumptions for the server-side estimate (store agent tool loop + attack classifier), per shopper turn. */
export const SERVER_ASSUMPTIONS = {
  storeSystemTokens: 3000,
  historyTokensPerTurn: 350,
  storeCallsPerTurn: 1.5, // tool loop: some turns need a tool round-trip
  storeOutputTokens: 300,
  classifierInputTokens: 600,
  classifierOutputTokens: 40,
};

export function serverTurnEstimateUsd(turnIndex: number, storeModel: string, classifierModel: string): number {
  const a = SERVER_ASSUMPTIONS;
  const storeIn = (a.storeSystemTokens + a.historyTokensPerTurn * turnIndex) * a.storeCallsPerTurn;
  return usageCostUsd(storeModel, { ...emptyUsage(), inputTokens: storeIn, outputTokens: a.storeOutputTokens * a.storeCallsPerTurn })
    + usageCostUsd(classifierModel, { ...emptyUsage(), inputTokens: a.classifierInputTokens, outputTokens: a.classifierOutputTokens });
}

export interface ProjectionInput {
  runs: { kind: 'attacker' | 'honest'; whiteBox: boolean }[];
  maxTurns: number;
  models: { attacker: string; honest: string; storeAgent: string; classifier: string };
}

/**
 * Rough pre-flight projection. Attackers must persist (no giving up before maxTurns-2), so they are assumed to use
 * ~90% of max turns plus occasional coaching re-asks; honest runs ~60%. The persona system prompt is cached after turn 1.
 */
export function projectBatchCostUsd({ runs, maxTurns, models }: ProjectionInput): number {
  let total = 0;
  for (const r of runs) {
    const model = r.kind === 'attacker' ? models.attacker : models.honest;
    const sys = r.whiteBox ? 14000 : 1500;
    const turns = Math.max(1, Math.round(maxTurns * (r.kind === 'attacker' ? 1.0 : 0.6)));
    for (let t = 0; t < turns; t++) {
      const u: TokenUsage = {
        inputTokens: 450 * t + 200,
        outputTokens: 700,
        cacheReadTokens: t === 0 ? 0 : sys,
        cacheWriteTokens: t === 0 ? sys : 0,
      };
      total += usageCostUsd(model, u) + serverTurnEstimateUsd(t, models.storeAgent, models.classifier);
    }
  }
  return total;
}

/** Shared across concurrent runs; trips once the running total passes the budget. */
export class CostMeter {
  persona = 0;
  serverEstimate = 0;
  constructor(readonly budgetUsd: number) {}
  get total() { return this.persona + this.serverEstimate; }
  get exceeded() { return this.total > this.budgetUsd; }
  addPersona(usd: number) { this.persona += usd; }
  addServer(usd: number) { this.serverEstimate += usd; }
  line() {
    return `$${this.total.toFixed(3)} of $${this.budgetUsd.toFixed(2)} (persona $${this.persona.toFixed(3)} + server est. $${this.serverEstimate.toFixed(3)})`;
  }
}
