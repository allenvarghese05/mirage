// Loads config from .secrets/dev.keys (KEY=VALUE lines) first, then process.env as fallback.
// The project file wins so a stray shell variable (e.g. ANTHROPIC_API_KEY) can never override the key chosen for Mirage.
// Never log values. Never send them to the browser.
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function loadKeysFile(): Record<string, string> {
  const path = resolve(process.cwd(), '.secrets/dev.keys');
  if (!existsSync(path)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && m[2] !== '') out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return out;
}

const file = loadKeysFile();
const get = (k: string, fallback = ''): string => file[k] ?? process.env[k] ?? fallback;

export const config = {
  port: Number(get('PORT', '8787')),
  dbPath: get('MIRAGE_DB', 'data/mirage.sqlite'),
  sim: get('MIRAGE_SIM') === '1',
  paypal: {
    clientId: get('PAYPAL_CLIENT_ID'),
    clientSecret: get('PAYPAL_CLIENT_SECRET'),
    base: get('PAYPAL_BASE', 'https://api-m.sandbox.paypal.com'),
    merchantId: get('PAYPAL_MERCHANT_ID'),
    webhookId: get('PAYPAL_WEBHOOK_ID'),
  },
  sandboxBuyers: [
    { email: get('SANDBOX_BUYER_EMAIL'), password: get('SANDBOX_BUYER_PASSWORD') },
    { email: get('SANDBOX_BUYER2_EMAIL'), password: get('SANDBOX_BUYER2_PASSWORD') },
  ].filter((b) => b.email),
  anthropicKey: get('ANTHROPIC_API_KEY'),
  /** Hard cap on total Claude API spend across ALL Mirage processes (ledger in data/llm-spend.jsonl). */
  llmBudgetUsd: Number(get('MIRAGE_LLM_BUDGET_USD', '5')),
  llmLedgerPath: get('MIRAGE_LLM_LEDGER', 'data/llm-spend.jsonl'),
  models: {
    storeAgent: get('MIRAGE_STORE_MODEL', 'claude-haiku-5-5'),
    attacker: get('MIRAGE_ATTACKER_MODEL', 'claude-haiku-5-5'),
    honest: get('MIRAGE_HONEST_MODEL', 'claude-haiku-5-5'),
    classifier: get('MIRAGE_CLASSIFIER_MODEL', 'claude-haiku-5-5'),
  },
  discordWebhook: get('DISCORD_WEBHOOK_URL'),
  decoySecret: get('MIRAGE_DECOY_SECRET', 'dev-only-insecure-decoy-secret-change-me'),
  publicBaseUrl: get('PUBLIC_BASE_URL', 'http://localhost:5173'),
};

export function requireKeys(...keys: (keyof typeof config.paypal | 'anthropicKey')[]): void {
  const missing = keys.filter((k) => (k === 'anthropicKey' ? !config.anthropicKey : !config.paypal[k as keyof typeof config.paypal]));
  if (missing.length) throw new Error(`Missing config: ${missing.join(', ')} (fill .secrets/dev.keys)`);
}
