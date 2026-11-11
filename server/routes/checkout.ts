// Checkout routes (Workstream B). Paths are absolute: mount with app.use(checkoutRouter).
//   POST /api/checkout
//   POST /api/checkout/:orderId/approved
//   GET  /api/orders/:orderId/status
//   POST /api/dashboard/review/:orderId
//   GET  /api/dashboard/payers/:payerId/history   (PayPal history via the Agent Toolkit; not yet in shared/api.ts)
import express, { Router, type NextFunction, type Request, type Response } from 'express';
import { getPaypalDeps, type PaypalLayerDeps } from '../paypal/deps';
import { approve, checkout, HttpError, MESSAGES, orderStatus, review } from '../paypal/orders';
import { getPayerHistory, type PayerHistory } from '../paypal/toolkit';

export { MESSAGES };

type Handler = (req: Request, deps: PaypalLayerDeps) => Promise<unknown> | unknown;

export function createCheckoutRouter(getDeps: () => PaypalLayerDeps = getPaypalDeps): Router {
  const r = Router();
  const json = express.json({ limit: '100kb' });

  const handle = (fn: Handler) => async (req: Request, res: Response, _next: NextFunction) => {
    try {
      res.json(await fn(req, getDeps()));
    } catch (e) {
      if (e instanceof HttpError) {
        res.status(e.status).json(e.body ?? { error: e.message, message: e.message });
        return;
      }
      console.error('[checkout]', (e as Error).message);
      res.status(500).json({ error: 'Something went wrong. You have not been charged.' });
    }
  };

  r.post('/api/checkout', json, handle((req, deps) => checkout(deps, req.body, {
    ip: req.ip,
    userAgent: req.get('user-agent'),
    wantsRealPaypal: req.get('x-mirage-real-paypal') === '1',
  })));
  r.post('/api/checkout/:orderId/approved', json, handle((req, deps) => approve(deps, String(req.params.orderId), req.body)));
  r.get('/api/orders/:orderId/status', handle((req, deps) => orderStatus(deps, String(req.params.orderId))));
  r.post('/api/dashboard/review/:orderId', json, handle((req, deps) => review(deps, String(req.params.orderId), req.body)));
  r.get('/api/dashboard/payers/:payerId/history', handle(async (req, deps): Promise<PayerHistory> => {
    const payerId = String(req.params.payerId);
    try {
      return await getPayerHistory(deps.toolkit(), payerId);
    } catch (e) {
      return { payerId, source: 'paypal-agent-toolkit:list_transactions', transactions: [], error: (e as Error).message };
    }
  }));
  return r;
}

export const checkoutRouter = createCheckoutRouter();
