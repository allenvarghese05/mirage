import { describe, expect, it } from 'vitest';
import { createToolkitRunner, executeRefund, getPayerHistory, toolkitGetOrder, ToolkitError, type ToolkitTools } from './toolkit';

/** Mimics the AI SDK tools the toolkit returns: execute(args) resolves to a JSON string. */
function fakeTools(impl: Record<string, (args: any) => unknown>) {
  const calls: { method: string; args: any }[] = [];
  const tools: ToolkitTools = {};
  for (const [method, fn] of Object.entries(impl)) {
    tools[method] = { execute: async (args: any) => { calls.push({ method, args }); return JSON.stringify(fn(args)); } };
  }
  return { tools, calls };
}

describe('real PayPal Agent Toolkit', () => {
  it('builds in sandbox mode with exactly the tools Mirage uses', () => {
    const runner = createToolkitRunner({ clientId: 'test-id', clientSecret: 'test-secret', base: 'https://api-m.sandbox.paypal.com' });
    expect(runner.methods().sort()).toEqual(['create_refund', 'get_order', 'list_transactions']);
  });

  it('refuses a non-sandbox base', () => {
    expect(() => createToolkitRunner({ clientId: 'a', clientSecret: 'b', base: 'https://api-m.paypal.com' })).toThrow(/sandbox/i);
  });
});

describe('toolkit calls', () => {
  it('get_order parses the JSON result', async () => {
    const f = fakeTools({ get_order: (a) => ({ id: a.id, status: 'APPROVED' }) });
    const runner = createToolkitRunner({ tools: () => f.tools });
    expect(await toolkitGetOrder(runner, 'O1')).toEqual({ id: 'O1', status: 'APPROVED' });
    expect(f.calls).toEqual([{ method: 'get_order', args: { id: 'O1' } }]);
  });

  it('surfaces toolkit error payloads as ToolkitError', async () => {
    const f = fakeTools({ get_order: () => ({ error: { message: 'Request failed with status code 404', type: 'paypal_error' } }) });
    const runner = createToolkitRunner({ tools: () => f.tools });
    await expect(toolkitGetOrder(runner, 'O1')).rejects.toBeInstanceOf(ToolkitError);
  });

  it('create_refund sends the capture id and amount', async () => {
    const f = fakeTools({ create_refund: () => ({ id: 'REF1', status: 'COMPLETED' }) });
    const runner = createToolkitRunner({ tools: () => f.tools });
    expect(await executeRefund(runner, { captureId: 'CAP1', amountCents: 9500, note: 'Refund for NP-10231' })).toEqual({ id: 'REF1', status: 'COMPLETED' });
    expect(f.calls[0].args).toEqual({ capture_id: 'CAP1', amount: { currency_code: 'USD', value: '95.00' }, note_to_payer: 'Refund for NP-10231' });
  });

  it('payer history filters list_transactions to the payer and never throws', async () => {
    const f = fakeTools({
      list_transactions: () => ({
        transaction_details: [
          { transaction_info: { transaction_id: 'T1', transaction_initiation_date: '2026-11-09T10:00:00+0000', transaction_amount: { currency_code: 'USD', value: '57.00' }, transaction_status: 'S', transaction_event_code: 'T0006' }, payer_info: { account_id: 'DEVPAYER01' } },
          { transaction_info: { transaction_id: 'T2', transaction_amount: { currency_code: 'USD', value: '9.00' } }, payer_info: { account_id: 'OTHER' } },
        ],
      }),
    });
    const runner = createToolkitRunner({ tools: () => f.tools });
    const h = await getPayerHistory(runner, 'DEVPAYER01');
    expect(h).toEqual({
      payerId: 'DEVPAYER01', source: 'paypal-agent-toolkit:list_transactions',
      transactions: [{ transactionId: 'T1', date: '2026-11-09T10:00:00+0000', amountCents: 5700, currency: 'USD', status: 'S', eventCode: 'T0006' }],
    });

    const broken = createToolkitRunner({ tools: () => fakeTools({ list_transactions: () => ({ error: { message: 'NOT_AUTHORIZED' } }) }).tools });
    const h2 = await getPayerHistory(broken, 'DEVPAYER01');
    expect(h2.transactions).toEqual([]);
    expect(h2.error).toMatch(/NOT_AUTHORIZED/);
  });

  it('recreates the toolkit after its max age (the toolkit caches its OAuth token forever)', async () => {
    let built = 0;
    let now = 0;
    const runner = createToolkitRunner({ tools: () => { built++; return fakeTools({ get_order: () => ({ id: 'O', status: 'APPROVED' }) }).tools; }, maxAgeMs: 1000, now: () => now });
    await toolkitGetOrder(runner, 'O');
    now = 500;
    await toolkitGetOrder(runner, 'O');
    now = 1500;
    await toolkitGetOrder(runner, 'O');
    expect(built).toBe(2);
  });
});

describe('per-call idempotency key', () => {
  it('builds a dedicated toolkit carrying the PayPal-Request-Id for that call only', async () => {
    const seen: (string | undefined)[] = [];
    const runner = createToolkitRunner({
      tools: (ctx) => { seen.push(ctx?.requestId); return fakeTools({ create_refund: () => ({ id: 'R', status: 'COMPLETED' }) }).tools; },
    });
    await executeRefund(runner, { captureId: 'CAP1', amountCents: 100, requestId: 'mirage-refund-rf1' });
    await executeRefund(runner, { captureId: 'CAP1', amountCents: 100 });
    expect(seen).toEqual([undefined, 'mirage-refund-rf1']);
  });
});

describe('toolkit failure shapes', () => {
  it('treats {ok:false, status, code, message} as a failure with PayPal\'s message', async () => {
    const f = fakeTools({ create_refund: () => ({ ok: false, status: 422, code: 'UNPROCESSABLE_ENTITY', message: 'CAPTURE_FULLY_REFUNDED' }) });
    const runner = createToolkitRunner({ tools: () => f.tools });
    await expect(executeRefund(runner, { captureId: 'CAP1' })).rejects.toThrow(/CAPTURE_FULLY_REFUNDED/);
  });
});
