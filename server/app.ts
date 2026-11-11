// Express app factory (used by server/index.ts and by supertest).
import express, { type ErrorRequestHandler } from 'express';
import { checkoutRouter } from './routes/checkout';
import { webhookRouter } from './routes/webhook';
import { chatRouter } from './routes/chat';
import { dashboardRouter } from './routes/dashboard';

export function createApp(): express.Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
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
