// Server entry point: `npm run dev:server` / `npm start`.
import express from 'express';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { config } from './config';
import { createApp } from './app';
import { getDb } from './db';
import { fakeLlmEnabled } from './agent/llm';

// Hard rule 2: sandbox only.
const paypalHost = (() => { try { return new URL(config.paypal.base).host; } catch { return ''; } })();
if (paypalHost !== 'api-m.sandbox.paypal.com') {
  console.error(`Refusing to start: PAYPAL_BASE must be the PayPal sandbox (got host "${paypalHost}").`);
  process.exit(1);
}

getDb();
const app = createApp();

if (process.env.NODE_ENV === 'production') {
  const webDir = resolve(process.cwd(), 'dist/web');
  if (existsSync(webDir)) {
    app.use(express.static(webDir, { index: false, maxAge: '1h' }));
    app.get(/^(?!\/api\/).*/, (_req, res) => res.sendFile(resolve(webDir, 'index.html')));
  } else {
    console.warn('[server] dist/web not found; run `npm run build` to serve the UI.');
  }
}

app.listen(config.port, () => {
  console.log(`[server] Mirage listening on :${config.port}${fakeLlmEnabled() ? ' (MIRAGE_FAKE_LLM=1: scripted agent, no API calls)' : ''}${config.sim ? ' (MIRAGE_SIM=1)' : ''}`);
});
