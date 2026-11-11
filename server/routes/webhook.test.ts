import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createCheckoutRouter } from './checkout';
import { createWebhookRouter } from './webhook';
import { addSession, kinds, makeTestDeps, type TestDeps } from '../paypal/test-helpers';

const DEV = { payerId: 'DEVPAYER01', name: 'Dev Patel', email: 'dev@example.com' };
let d: TestDeps;
let app: express.Express;

function build(cfg: Parameters<typeof makeTestDeps>[0] = {}) {
  d = makeTestDeps(cfg);
  app = express();
  app.use(createCheckoutRouter(() => d));
  app.use(createWebhookRouter(() => d));
  addSession(d.db, { id: 's1' });
  d.codes.set('NP-STAFF-00A7-K9MD', { sessionId: 's1', kind: 'staff_code' });
}

const event = (orderId: string, type = 'CHECKOUT.ORDER.APPROVED') => ({ id: 'WH-1', event_type: type, resource: { id: orderId } });
const hook = (body: object) => request(app).post('/api/paypal/webhook').set('paypal-transmission-id', 't1').send(body);
const newOrder = async (code?: string) => (await request(app).post('/api/checkout').send({ sessionId: 's1', items: [{ productId: 'np-jacket', qty: 1 }], code })).body.orderId as string;

beforeEach(() => build());

describe('POST /api/paypal/webhook', () => {
  it('CHECKOUT.ORDER.APPROVED runs the approval handler (honest -> captured)', async () => {
    const id = await newOrder();
    d.pp.approve(id, DEV);
    const r = await hook(event(id));
    expect(r.status).toBe(200);
    expect(d.pp.captures).toHaveLength(1);
  });

  it('a trapped order approved via webhook is held, never captured, and replays are idempotent', async () => {
    const id = await newOrder('NP-STAFF-00A7-K9MD');
    d.pp.approve(id, DEV);
    await hook(event(id));
    await hook(event(id));
    const status = await request(app).get(`/api/orders/${id}/status`);
    expect(status.body.status).toBe('PENDING_REVIEW');
    expect(d.pp.captures).toHaveLength(0);
    expect(kinds(d).filter((k) => k === 'IDENTITY_CAPTURED')).toHaveLength(1);
  });

  it('the webhook body cannot fake an approval: the handler re-reads the order from PayPal', async () => {
    const id = await newOrder();
    const r = await hook(event(id));
    expect(r.status).toBe(200);
    expect(d.pp.captures).toHaveLength(0);
  });

  it('ignores unknown orders and other event types with 200', async () => {
    expect((await hook(event('NOPE'))).status).toBe(200);
    expect((await hook(event('X', 'PAYMENT.CAPTURE.COMPLETED'))).status).toBe(200);
    expect((await hook({})).status).toBe(200);
  });

  it('verifies the signature with PayPal when PAYPAL_WEBHOOK_ID is set', async () => {
    build({ webhookId: 'WEBHOOK123' });
    const id = await newOrder();
    d.pp.approve(id, DEV);
    const spy = vi.spyOn(d.pp, 'verifyWebhookSignature');
    d.pp.webhookValid = false;
    expect((await hook(event(id))).status).toBe(400);
    expect(d.pp.captures).toHaveLength(0);
    expect(spy.mock.calls[0][0]['paypal-transmission-id']).toBe('t1');
    expect(spy.mock.calls[0][2]).toBe('WEBHOOK123');
    d.pp.webhookValid = true;
    expect((await hook(event(id))).status).toBe(200);
    expect(d.pp.captures).toHaveLength(1);
  });

  it('rejects unverified webhooks in production when no webhook id is configured', async () => {
    build({ production: true, webhookId: '' });
    const id = await newOrder();
    d.pp.approve(id, DEV);
    expect((await hook(event(id))).status).toBe(403);
    expect(d.pp.captures).toHaveLength(0);
  });
});
