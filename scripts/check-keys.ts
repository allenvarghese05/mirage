// npm run check:keys: verifies .secrets/dev.keys without printing any values.
import { config } from '../server/config';

const line = (ok: boolean | null, name: string, note = '') =>
  console.log(`${ok === null ? '⚪' : ok ? '✅' : '❌'} ${name}${note ? ` (${note})` : ''}`);

async function paypal() {
  const { clientId, clientSecret, base } = config.paypal;
  if (!clientId || !clientSecret) return line(false, 'PayPal sandbox app', 'PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET empty');
  if (!base.includes('sandbox')) return line(false, 'PayPal sandbox app', 'PAYPAL_BASE is not the sandbox host');
  const r = await fetch(`${base}/v1/oauth2/token`, {
    method: 'POST',
    headers: { Authorization: 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
  });
  const j: any = await r.json().catch(() => ({}));
  line(r.ok, 'PayPal sandbox app', r.ok ? `OAuth OK, app ${j.app_id}` : `${r.status} ${j.error ?? ''} ${j.error_description ?? ''}`);
}

async function anthropic() {
  if (!config.anthropicKey) return line(false, 'Anthropic API key', 'ANTHROPIC_API_KEY empty');
  const r = await fetch('https://api.anthropic.com/v1/models?limit=1', {
    headers: { 'x-api-key': config.anthropicKey, 'anthropic-version': '2023-06-01' },
  });
  line(r.ok, 'Anthropic API key', r.ok ? 'valid' : `HTTP ${r.status}`);
}

await paypal().catch((e) => line(false, 'PayPal sandbox app', String(e.message ?? e)));
await anthropic().catch((e) => line(false, 'Anthropic API key', String(e.message ?? e)));
line(config.sandboxBuyers.length > 0, 'Sandbox buyer #1 (attacker)', config.sandboxBuyers.length ? 'email set' : 'SANDBOX_BUYER_EMAIL empty');
line(config.sandboxBuyers.length > 1 ? true : null, 'Sandbox buyer #2 (honest)', config.sandboxBuyers.length > 1 ? 'email set' : 'optional, empty');
line(!config.decoySecret.startsWith('dev-only') ? true : false, 'MIRAGE_DECOY_SECRET', config.decoySecret.startsWith('dev-only') ? 'empty, using insecure dev default' : 'set');
line(config.paypal.merchantId ? true : null, 'PAYPAL_MERCHANT_ID', config.paypal.merchantId ? 'set' : 'optional, empty');
line(config.discordWebhook ? true : null, 'DISCORD_WEBHOOK_URL', config.discordWebhook ? 'set' : 'optional, empty');
