// PayPal webhook (Workstream B). Mount with app.use(webhookRouter).
//   POST /api/paypal/webhook
// CHECKOUT.ORDER.APPROVED runs the same (idempotent) approval handler as POST /api/checkout/:id/approved.
// The handler never trusts the webhook body: it re-reads the order from PayPal, so even an unverified
// dev webhook can only trigger a real status check.
import express, { Router, type Request, type Response } from 'express';
import { getPaypalDeps, type PaypalLayerDeps } from '../paypal/deps';
import { approve, HttpError } from '../paypal/orders';

const SIG_HEADERS = ['paypal-auth-algo', 'paypal-cert-url', 'paypal-transmission-id', 'paypal-transmission-sig', 'paypal-transmission-time'];

export function createWebhookRouter(getDeps: () => PaypalLayerDeps = getPaypalDeps): Router {
  const r = Router();
  let warned = false;

  r.post('/api/paypal/webhook', express.json({ limit: '1mb' }), async (req: Request, res: Response) => {
    const deps = getDeps();
    const event = (req.body ?? {}) as { id?: string; event_type?: string; resource?: { id?: string } };

    if (deps.config.webhookId) {
      const headers = Object.fromEntries(SIG_HEADERS.map((h) => [h, req.get(h)]));
      let ok = false;
      try {
        ok = await deps.paypal().verifyWebhookSignature(headers, event, deps.config.webhookId);
      } catch (e) {
        console.warn('[webhook] signature verification call failed:', (e as Error).message);
      }
      if (!ok) {
        res.status(400).json({ error: 'webhook signature verification failed' });
        return;
      }
    } else if (deps.config.production) {
      res.status(403).json({ error: 'PAYPAL_WEBHOOK_ID is not set; unverified webhooks are refused in production' });
      return;
    } else if (!warned) {
      warned = true;
      console.warn('[webhook] PAYPAL_WEBHOOK_ID not set: accepting unverified webhooks (dev only)');
    }

    if (event.event_type === 'CHECKOUT.ORDER.APPROVED' && typeof event.resource?.id === 'string') {
      try {
        await approve(deps, event.resource.id, {}, { trustedSource: true });
      } catch (e) {
        // Unknown orders (not ours) and PayPal hiccups: acknowledge so PayPal doesn't retry forever;
        // the browser's onApprove call and the status endpoint still drive the order.
        if (!(e instanceof HttpError && e.status === 404)) console.warn('[webhook] approval handling failed:', (e as Error).message);
      }
    }
    res.status(200).json({ received: true });
  });
  return r;
}

export const webhookRouter = createWebhookRouter();
