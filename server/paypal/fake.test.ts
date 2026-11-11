import { describe, expect, it } from 'vitest';
import { createFakePayPal } from './fake';
import { PayPalHttpError } from './client';
import { payerFromOrder } from './payer';

const params = (over: Partial<Parameters<ReturnType<typeof createFakePayPal>['createOrder']>[0]> = {}) => ({
  totalCents: 5700, customId: 'mirage:s1:x', clientMetadataId: 'cm1', requestId: 'r1',
  description: 'd', returnUrl: 'http://localhost/r', cancelUrl: 'http://localhost/c', ...over,
});

const DEV = { payerId: 'DEVPAYER01', name: 'Dev Patel', email: 'dev@example.com', countryCode: 'US', shippingAddress: '1 Main St, Austin, TX 78701, US' };

describe('fake PayPal', () => {
  it('creates an order awaiting the payer with a sandbox approve URL', async () => {
    const pp = createFakePayPal();
    const o = await pp.createOrder(params());
    expect(o.status).toBe('PAYER_ACTION_REQUIRED');
    expect(new URL(o.approveUrl).hostname).toBe('www.sandbox.paypal.com');
    expect((await pp.getOrder(o.id)).purchase_units![0].amount!.value).toBe('57.00');
  });

  it('is idempotent on PayPal-Request-Id', async () => {
    const pp = createFakePayPal();
    const a = await pp.createOrder(params());
    const b = await pp.createOrder(params());
    expect(b.id).toBe(a.id);
  });

  it('refuses to capture an order the payer has not approved', async () => {
    const pp = createFakePayPal();
    const o = await pp.createOrder(params());
    const err = await pp.captureOrder(o.id, 'c1').catch((e) => e);
    expect(err).toBeInstanceOf(PayPalHttpError);
    expect(err.issue).toBe('ORDER_NOT_APPROVED');
    expect(pp.captures).toHaveLength(0);
  });

  it('captures an approved order once, even when replayed', async () => {
    const pp = createFakePayPal();
    const o = await pp.createOrder(params());
    pp.approve(o.id, DEV);
    const c1 = await pp.captureOrder(o.id, 'c1');
    const c2 = await pp.captureOrder(o.id, 'c1');
    expect(c1.status).toBe('COMPLETED');
    expect(c2.captureId).toBe(c1.captureId);
    expect(pp.captures).toHaveLength(1);
  });

  it('round-trips the approving payer through payerFromOrder', async () => {
    const pp = createFakePayPal();
    const o = await pp.createOrder(params());
    pp.approve(o.id, DEV);
    expect(payerFromOrder(await pp.getOrder(o.id))).toEqual(DEV);
  });

  it('getOrder on an unknown id throws 404', async () => {
    const err = await createFakePayPal().getOrder('NOPE').catch((e) => e);
    expect(err.status).toBe(404);
  });

  it('records risk calls and can be told to fail or throw', async () => {
    const pp = createFakePayPal();
    expect(await pp.putRiskContext('M', 'cm', { a: 1 })).toEqual({ ok: false, status: 403 });
    pp.riskResponse = { ok: true, status: 200 };
    expect((await pp.putRiskContext('M', 'cm', {})).ok).toBe(true);
    pp.riskThrows = true;
    await expect(pp.putRiskContext('M', 'cm', {})).rejects.toThrow();
    expect(pp.riskCalls).toHaveLength(3);
  });

  it('uses the configured id prefix (SIM- orders for the simulator)', async () => {
    const o = await createFakePayPal({ idPrefix: 'SIM-' }).createOrder(params());
    expect(o.id.startsWith('SIM-')).toBe(true);
  });
});

describe('payerFromOrder', () => {
  it('prefers payment_source.paypal and formats the shipping address', () => {
    const p = payerFromOrder({
      id: 'O', status: 'APPROVED',
      payer: { payer_id: 'LEGACY', email_address: 'old@example.com' },
      payment_source: { paypal: { account_id: 'ACC1', email_address: 'a@example.com', name: { given_name: 'Ann', surname: 'Lee' }, address: { country_code: 'GB' } } },
      purchase_units: [{ shipping: { address: { address_line_1: '9 High St', admin_area_2: 'London', postal_code: 'N1 1AA', country_code: 'GB' } } }],
    });
    expect(p).toEqual({ payerId: 'ACC1', name: 'Ann Lee', email: 'a@example.com', countryCode: 'GB', shippingAddress: '9 High St, London, N1 1AA, GB' });
  });

  it('returns null when the order has no payer yet', () => {
    expect(payerFromOrder({ id: 'O', status: 'PAYER_ACTION_REQUIRED' })).toBeNull();
  });
});
