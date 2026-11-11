// Loads config from process.env, then fills gaps from .secrets/dev.keys (KEY=VALUE lines).
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
const get = (k: string, fallback = ''): string => process.env[k] ?? file[k] ?? fallback;

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
