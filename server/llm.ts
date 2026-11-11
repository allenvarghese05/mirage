// The ONLY way Mirage code may call the Claude API.
// Enforces a hard spend cap (config.llmBudgetUsd, default $5) across every process
// (server, sim, scripts) via an append-only ledger file. Before each call it reserves the
// worst case for that call (full input estimate + max_tokens of output); if that could cross
// the cap, the call is refused with BudgetExceededError and nothing is sent.
import Anthropic from '@anthropic-ai/sdk';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from './config';

/** USD per 1M tokens [input, output]. Unknown models are priced as Opus (conservative). */
const PRICES: Record<string, [number, number]> = {
  'claude-haiku-5-5': [0.1, 0.5],
  'claude-sonnet-5-5': [2, 10],
  'claude-opus-5-5': [4, 20],
};
const FALLBACK_PRICE: [number, number] = [10, 50];

export class BudgetExceededError extends Error {
  constructor(public spentUsd: number, public capUsd: number, public neededUsd: number) {
    super(`Claude API budget reached: spent $${spentUsd.toFixed(4)} of $${capUsd.toFixed(2)} cap (next call could cost up to $${neededUsd.toFixed(4)}). Raise MIRAGE_LLM_BUDGET_USD only if the user approves.`);
    this.name = 'BudgetExceededError';
  }
}

function price(model: string): [number, number] {
  return PRICES[model] ?? FALLBACK_PRICE;
}

export function costOf(model: string, usage: Partial<Anthropic.Usage>): number {
  const [pin, pout] = price(model);
  const input = usage.input_tokens ?? 0;
  const cacheWrite = usage.cache_creation_input_tokens ?? 0;
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const output = usage.output_tokens ?? 0;
  // Haiku 5.5 doubles+ above 100K prompt tokens; use the higher rate when that happens.
  const long = model === 'claude-haiku-5-5' && input + cacheWrite + cacheRead > 100_000;
  const [i, o] = long ? [0.5, 2.5] : [pin, pout];
  return (input * i + cacheWrite * i * 1.25 + cacheRead * i * 0.1 + output * o) / 1_000_000;
}

export function spentUsd(ledgerPath = config.llmLedgerPath): number {
  if (!existsSync(ledgerPath)) return 0;
  let total = 0;
  for (const line of readFileSync(ledgerPath, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { total += Number(JSON.parse(line).usd) || 0; } catch { /* ignore partial line */ }
  }
  return total;
}

function record(entry: Record<string, unknown>, ledgerPath = config.llmLedgerPath) {
  mkdirSync(dirname(ledgerPath), { recursive: true });
  appendFileSync(ledgerPath, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n');
}

/** Rough upper bound for input tokens without a network call (~3.5 chars/token, padded). */
function estimateInputTokens(params: Anthropic.MessageCreateParamsNonStreaming): number {
  const chars = JSON.stringify({ s: params.system, m: params.messages, t: params.tools }).length;
  return Math.ceil(chars / 3) + 500;
}

let client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!config.anthropicKey) throw new Error('ANTHROPIC_API_KEY missing in .secrets/dev.keys');
  client ??= new Anthropic({ apiKey: config.anthropicKey });
  return client;
}

/** For tests: inject a fake client. */
export function __setClientForTests(c: Pick<Anthropic, 'messages'> | null) {
  client = c as Anthropic | null;
}

export interface CreateOpts { purpose: string; capUsd?: number; ledgerPath?: string }

export async function createMessage(
  params: Anthropic.MessageCreateParamsNonStreaming,
  opts: CreateOpts,
): Promise<Anthropic.Message> {
  const cap = opts.capUsd ?? config.llmBudgetUsd;
  const ledger = opts.ledgerPath ?? config.llmLedgerPath;
  const [pin, pout] = price(params.model);
  const worstCase = (estimateInputTokens(params) * pin * 1.25 + params.max_tokens * pout) / 1_000_000;
  const spent = spentUsd(ledger);
  if (spent + worstCase > cap) throw new BudgetExceededError(spent, cap, worstCase);

  const res = await getClient().messages.create(params);
  const usd = costOf(res.model ?? params.model, res.usage);
  record({ purpose: opts.purpose, model: res.model ?? params.model, usd, usage: res.usage }, ledger);
  return res;
}
