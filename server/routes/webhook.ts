// STUB owned by workstream B (paypal-layer). B replaces this file; keep the export name `webhookRouter`.
import { Router } from 'express';

export const webhookRouter = Router();

webhookRouter.post('/api/paypal/webhook', (_req, res) => {
  res.status(501).json({ error: 'webhook is not wired yet (paypal-layer)' });
});
