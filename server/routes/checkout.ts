// STUB owned by workstream B (paypal-layer). B replaces this file; keep the export name `checkoutRouter`.
// Real implementation: POST /api/checkout, POST /api/checkout/:orderId/approved, GET /api/orders/:orderId/status,
// POST /api/dashboard/review/:orderId (capture-capable). Paths are full (mounted at the app root).
import { Router } from 'express';

export const checkoutRouter = Router();

const notReady = (_req: unknown, res: { status: (n: number) => { json: (b: unknown) => void } }) => {
  res.status(501).json({ error: 'checkout is not wired yet (paypal-layer)' });
};
checkoutRouter.post('/api/checkout', notReady);
checkoutRouter.post('/api/checkout/:orderId/approved', notReady);
checkoutRouter.get('/api/orders/:orderId/status', notReady);
