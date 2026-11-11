// Server entry point: `npm run dev:server` / `npm start`.
import express from 'express';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { config } from './config';
import { createApp, startupProblems } from './app';
import { getDb } from './db';
import { fakeLlmEnabled } from './agent/llm';
import { registerRefundExecutor } from './mirage/policy';
import { paypalRefundExecutor } from './paypal/refunds';

// Hard rule 2 (sandbox only) and a real decoy secret in production.
const problems = startupProblems(config);
for (const w of problems.warnings) console.warn(`\n⚠️  WARNING: ${w}\n`);
if (problems.fatal.length) {
  for (const f of problems.fatal) console.error(`Refusing to start: ${f}`);
  process.exit(1);
}

getDb();
const app = createApp();
// Honest policy refunds run on PayPal's Agent Toolkit (runtime only; unit tests never reach the toolkit).
registerRefundExecutor(paypalRefundExecutor);

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
