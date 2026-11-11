// Cost guard (Workstream D). Persona-side LLM spend is measured from API usage; the store agent's spend happens
// inside the server and is not visible over HTTP, so it is ESTIMATED per turn. Prices are USD per million tokens
// (Anthropic first-party list prices, Nov 2026).
import type { TokenUsage } from './types';

export interface ModelPrice { input: number; output: number; cacheRead: number; cacheWrite: number }

const p = (input: number, output: number, cacheRead = input * 0.1): ModelPrice =>
  ({ input, output, cacheRead, cacheWrite: input * 1.25 });

export const PRICES: Record<string, ModelPrice> = {
  'claude-fable-5-1': p(10, 50, 0.25),
  'claude-opus-5-5': p(4, 20, 0.2),
  'claude-opus-5': p(5, 25),
  'claude-sonnet-5-5': p(2, 10, 0.2),
  'claude-sonnet-5': p(2, 10, 0.2),
  'claude-haiku-5-5': p(0.1, 0.5),
  'claude-haiku-4-5': p(1, 5),
};
/** Unknown models are priced like Opus 5.5 so the guard errs on the expensive side. */
export const priceOf = (model: string): ModelPrice => PRICES[model] ?? PRICES['claude-opus-5-5'];

export const emptyUsage = (): TokenUsage => ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });

export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
  };
}

export function usageCostUsd(model: string, u: TokenUsage): number {
  const pr = priceOf(model);
  return (u.inputTokens * pr.input + u.outputTokens * pr.output + u.cacheReadTokens * pr.cacheRead + u.cacheWriteTokens * pr.cacheWrite) / 1e6;
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

/** Rough pre-flight projection: assumes runs average 75% of max turns and the persona system prompt is cached after turn 1. */
export function projectBatchCostUsd({ runs, maxTurns, models }: ProjectionInput): number {
  const turns = Math.max(1, Math.round(maxTurns * 0.75));
  let total = 0;
  for (const r of runs) {
    const model = r.kind === 'attacker' ? models.attacker : models.honest;
    const sys = r.whiteBox ? 14000 : 1500;
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
