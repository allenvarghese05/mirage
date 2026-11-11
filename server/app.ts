// Express app factory (used by server/index.ts and by supertest).
import express, { type ErrorRequestHandler } from 'express';
import type { config as appConfig } from './config';
import { checkoutRouter } from './routes/checkout';
import { webhookRouter } from './routes/webhook';
import { chatRouter } from './routes/chat';
import { dashboardRouter } from './routes/dashboard';
import { getDb } from './db';
import { traceCode, isTrappedQuote } from './mirage/decoys';
import { emit } from './mirage/tripwire';
import { setPaypalDeps } from './paypal/deps';

/** Wire workstream B (paypal-layer) to workstream A's data layer, decoys and tripwire bus.
 *  Pass getDb itself (not getDb()) so resetDb() in tests is picked up. */
export function wirePaypalLayer(): void {
  setPaypalDeps({ getDb, traceCode, emit, isTrappedQuote });
}

export const DEV_DECOY_SECRET = 'dev-only-insecure-decoy-secret-change-me';

/** Checks run before listening. fatal = refuse to start; warnings = log loudly. */
export function startupProblems(cfg: typeof appConfig, nodeEnv = process.env.NODE_ENV): { fatal: string[]; warnings: string[] } {
  const fatal: string[] = [];
  const warnings: string[] = [];
  let host = '';
  try { host = new URL(cfg.paypal.base).host; } catch { /* invalid URL */ }
  if (host !== 'api-m.sandbox.paypal.com') fatal.push(`PAYPAL_BASE must be the PayPal sandbox (got host "${host}").`);
  const weakSecret = !cfg.decoySecret || cfg.decoySecret === DEV_DECOY_SECRET || cfg.decoySecret.length < 16;
  if (weakSecret) {
    const msg = 'MIRAGE_DECOY_SECRET is the dev-only default (or too short): anyone who knows it can forge self-tracing decoy codes. Set a long random value in .secrets/dev.keys.';
    if (nodeEnv === 'production') fatal.push(msg); else warnings.push(msg);
  }
  return { fatal, warnings };
}

export function createApp(): express.Express {
  wirePaypalLayer();
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  // Sim batches can be large; this route-level parser runs first (the global one then skips the parsed body).
  app.post('/api/dashboard/sim-runs', express.json({ limit: '5mb' }));
  app.use(express.json({ limit: '1mb' }));

  // Workstream B first: its routes (checkout, approval, order status, webhook, capture-capable review) take precedence.
  app.use(checkoutRouter);
  app.use(webhookRouter);
  app.use(chatRouter);
  app.use(dashboardRouter);

  app.use('/api', (_req, res) => { res.status(404).json({ error: 'not found' }); });

  const onError: ErrorRequestHandler = (err, _req, res, _next) => {
    const status = typeof err?.status === 'number' ? err.status : 500;
    if (status >= 500) console.error('[app] unhandled error:', err?.message ?? err);
    res.status(status).json({ error: status >= 500 ? 'internal error' : String(err?.message ?? 'bad request') });
  };
  app.use(onError);
  return app;
}
