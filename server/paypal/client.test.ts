import { describe, expect, it } from 'vitest';
import { assertSandboxBase, createPayPalClient, PayPalHttpError } from './client';

type Call = { url: string; method: string; headers: Record<string, string>; body?: string };

/** Scripted fetch: each handler gets the call and returns [status, json]. */
function scriptedFetch(handlers: ((c: Call) => [number, unknown] | undefined)[]) {
  const calls: Call[] = [];
  const impl = async (input: string | URL | Request, init?: RequestInit) => {
    const c: Call = {
      url: String(input),
      method: init?.method ?? 'GET',
      headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)),
      body: init?.body as string | undefined,
    };
    calls.push(c);
    for (const h of handlers) {
      const r = h(c);
      if (r) return new Response(r[1] === undefined ? '' : JSON.stringify(r[1]), { status: r[0], headers: { 'paypal-debug-id': 'dbg1' } });
    }
    return new Response(JSON.stringify({ name: 'NOT_SCRIPTED' }), { status: 500 });
  };
  return { calls, impl: impl as typeof fetch };
}

const token = (c: Call): [number, unknown] | undefined =>
  c.url.endsWith('/v1/oauth2/token') ? [200, { access_token: 'tok-1', expires_in: 32400 }] : undefined;

const BASE = 'https://api-m.sandbox.paypal.com';
const mk = (handlers: ((c: Call) => [number, unknown] | undefined)[]) => {
  const f = scriptedFetch([token, ...handlers]);
  const client = createPayPalClient({ clientId: 'id', clientSecret: 'secret', base: BASE, fetchImpl: f.impl });
  return { client, calls: f.calls };
};

describe('assertSandboxBase', () => {
  it('accepts the PayPal sandbox API host', () => {
    expect(() => assertSandboxBase('https://api-m.sandbox.paypal.com')).not.toThrow();
    expect(() => assertSandboxBase('https://api-m.sandbox.paypal.com/')).not.toThrow();
  });
  it('refuses the live host and anything else', () => {
    expect(() => assertSandboxBase('https://api-m.paypal.com')).toThrow(/sandbox/i);
    expect(() => assertSandboxBase('https://evil.example.com')).toThrow(/sandbox/i);
    expect(() => assertSandboxBase('http://api-m.sandbox.paypal.com')).toThrow(/sandbox/i);
    expect(() => assertSandboxBase('not a url')).toThrow();
  });
  it('createPayPalClient refuses a non-sandbox base', () => {
    expect(() => createPayPalClient({ clientId: 'a', clientSecret: 'b', base: 'https://api-m.paypal.com' })).toThrow(/sandbox/i);
  });
});

describe('createOrder', () => {
  it('sends intent CAPTURE, custom_id, metadata id and request id headers, and returns the approve link', async () => {
    const { client, calls } = mk([
      (c) => (c.url.endsWith('/v2/checkout/orders') && c.method === 'POST'
        ? [201, { id: 'ORDER1', status: 'PAYER_ACTION_REQUIRED', links: [{ rel: 'payer-action', href: 'https://www.sandbox.paypal.com/checkoutnow?token=ORDER1' }] }]
        : undefined),
    ]);
    const r = await client.createOrder({
      totalCents: 5700, customId: 'mirage:s1:abc', clientMetadataId: 'cmid-1', requestId: 'req-1',
      description: 'Northpeak order', brandName: 'Northpeak Outfitters',
      returnUrl: 'http://localhost:5173/r', cancelUrl: 'http://localhost:5173/c',
    });
    expect(r).toEqual({ id: 'ORDER1', status: 'PAYER_ACTION_REQUIRED', approveUrl: 'https://www.sandbox.paypal.com/checkoutnow?token=ORDER1' });
    const create = calls.find((c) => c.url.endsWith('/v2/checkout/orders'))!;
    expect(create.headers['PayPal-Client-Metadata-Id']).toBe('cmid-1');
    expect(create.headers['PayPal-Request-Id']).toBe('req-1');
    expect(create.headers.Authorization).toBe('Bearer tok-1');
    const body = JSON.parse(create.body!);
    expect(body.intent).toBe('CAPTURE');
    expect(body.purchase_units[0].custom_id).toBe('mirage:s1:abc');
    expect(body.purchase_units[0].amount).toEqual({ currency_code: 'USD', value: '57.00' });
    expect(body.payment_source.paypal.experience_context.return_url).toBe('http://localhost:5173/r');
  });

  it('caches the OAuth token across calls', async () => {
    const { client, calls } = mk([(c) => (c.url.includes('/v2/checkout/orders/') ? [200, { id: 'X', status: 'APPROVED' }] : undefined)]);
    await client.getOrder('X');
    await client.getOrder('X');
    expect(calls.filter((c) => c.url.endsWith('/v1/oauth2/token'))).toHaveLength(1);
  });

  it('refreshes the token once on a 401', async () => {
    let n = 0;
    const { client, calls } = mk([
      (c) => (c.url.endsWith('/v2/checkout/orders/X') ? (n++ === 0 ? [401, { name: 'AUTHENTICATION_FAILURE' }] : [200, { id: 'X', status: 'APPROVED' }]) : undefined),
    ]);
    expect((await client.getOrder('X')).status).toBe('APPROVED');
    expect(calls.filter((c) => c.url.endsWith('/v1/oauth2/token'))).toHaveLength(2);
  });
});

describe('errors', () => {
  it('throws PayPalHttpError with status, issue and debug id, and never includes credentials', async () => {
    const { client } = mk([
      (c) => (c.url.endsWith('/capture') ? [422, { name: 'UNPROCESSABLE_ENTITY', details: [{ issue: 'ORDER_NOT_APPROVED' }], message: 'nope' }] : undefined),
    ]);
    const err = await client.captureOrder('X', 'cap-X').catch((e) => e);
    expect(err).toBeInstanceOf(PayPalHttpError);
    expect(err.status).toBe(422);
    expect(err.issue).toBe('ORDER_NOT_APPROVED');
    expect(err.debugId).toBe('dbg1');
    expect(String(err.message)).not.toContain('secret');
  });
});

describe('captureOrder / refundCapture', () => {
  it('captures with an idempotency key and returns the capture id', async () => {
    const { client, calls } = mk([
      (c) => (c.url.endsWith('/v2/checkout/orders/X/capture')
        ? [201, { id: 'X', status: 'COMPLETED', purchase_units: [{ payments: { captures: [{ id: 'CAP1', status: 'COMPLETED' }] } }] }]
        : undefined),
    ]);
    const r = await client.captureOrder('X', 'cap-X');
    expect(r).toEqual({ orderId: 'X', status: 'COMPLETED', captureId: 'CAP1', captureStatus: 'COMPLETED' });
    expect(calls.at(-1)!.headers['PayPal-Request-Id']).toBe('cap-X');
  });

  it('refunds a capture (partial amount)', async () => {
    const { client, calls } = mk([
      (c) => (c.url.endsWith('/v2/payments/captures/CAP1/refund') ? [201, { id: 'REF1', status: 'COMPLETED' }] : undefined),
    ]);
    const r = await client.refundCapture('CAP1', { amountCents: 500, requestId: 'ref-1' });
    expect(r).toEqual({ id: 'REF1', status: 'COMPLETED' });
    expect(JSON.parse(calls.at(-1)!.body!).amount).toEqual({ currency_code: 'USD', value: '5.00' });
  });
});

describe('verifyWebhookSignature', () => {
  it('posts the transmission headers and returns true on SUCCESS', async () => {
    const { client, calls } = mk([
      (c) => (c.url.endsWith('/v1/notifications/verify-webhook-signature') ? [200, { verification_status: 'SUCCESS' }] : undefined),
    ]);
    const ok = await client.verifyWebhookSignature({
      'paypal-auth-algo': 'SHA256withRSA', 'paypal-cert-url': 'https://api.sandbox.paypal.com/cert',
      'paypal-transmission-id': 't1', 'paypal-transmission-sig': 'sig', 'paypal-transmission-time': 'now',
    }, { id: 'WH-1' }, 'WEBHOOK123');
    expect(ok).toBe(true);
    const body = JSON.parse(calls.at(-1)!.body!);
    expect(body.webhook_id).toBe('WEBHOOK123');
    expect(body.transmission_id).toBe('t1');
    expect(body.webhook_event).toEqual({ id: 'WH-1' });
  });

  it('returns false on FAILURE', async () => {
    const { client } = mk([
      (c) => (c.url.endsWith('/verify-webhook-signature') ? [200, { verification_status: 'FAILURE' }] : undefined),
    ]);
    expect(await client.verifyWebhookSignature({}, {}, 'W')).toBe(false);
  });
});

describe('putRiskContext', () => {
  it('returns ok/status instead of throwing on a PayPal error', async () => {
    const { client, calls } = mk([(c) => (c.url.includes('/v1/risk/transaction-contexts/') ? [403, { name: 'NOT_AUTHORIZED' }] : undefined)]);
    const r = await client.putRiskContext('MERCH1', 'cmid-1', { additional_data: [] });
    expect(r).toEqual({ ok: false, status: 403 });
    expect(calls.at(-1)!.method).toBe('PUT');
    expect(calls.at(-1)!.url).toBe(`${BASE}/v1/risk/transaction-contexts/MERCH1/cmid-1`);
  });
});
