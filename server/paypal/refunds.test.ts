import { afterEach, describe, expect, it } from 'vitest';
import { resetPaypalDeps, setPaypalDeps } from './deps';
import { executeCaptureRefund, paypalRefundExecutor } from './refunds';
import { createToolkitRunner } from './toolkit';
import { makeTestDeps } from './test-helpers';

afterEach(() => resetPaypalDeps());

describe('executeCaptureRefund (honest policy refunds, baseline manager refunds)', () => {
  it('refunds through the Agent Toolkit', async () => {
    const d = makeTestDeps();
    const calls: any[] = [];
    d.toolkitTools.create_refund = { execute: async (args: any) => { calls.push(args); return JSON.stringify({ id: 'REF9', status: 'COMPLETED' }); } };
    setPaypalDeps(d);
    expect(await executeCaptureRefund({ captureId: 'CAP1', amountCents: 9500, note: 'Refund NP-10231' })).toEqual({ ok: true, refundId: 'REF9', status: 'COMPLETED' });
    expect(calls[0]).toMatchObject({ capture_id: 'CAP1', amount: { value: '95.00' } });
  });

  it('returns ok:false with the reason instead of throwing', async () => {
    const d = makeTestDeps();
    d.toolkitTools.create_refund = { execute: async () => JSON.stringify({ error: { message: 'CAPTURE_FULLY_REFUNDED' } }) };
    setPaypalDeps(d);
    const r = await executeCaptureRefund({ captureId: 'CAP1', amountCents: 100 });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/CAPTURE_FULLY_REFUNDED/);
  });

  it('returns ok:false when PayPal is not configured', async () => {
    const d = makeTestDeps();
    d.toolkit = () => { throw new Error('Missing PAYPAL_CLIENT_ID'); };
    setPaypalDeps(d);
    expect((await executeCaptureRefund({ captureId: 'CAP1' })).ok).toBe(false);
  });
});

describe('paypalRefundExecutor (registered with A via registerRefundExecutor)', () => {
  const req = { refundId: 'rf1', sessionId: 's1', orderRef: 'NP-10231', amountCents: 9500 };

  it('skips refunds with no PayPal capture (recorded only)', async () => {
    const d = makeTestDeps();
    let called = false;
    d.toolkitTools.create_refund = { execute: async () => { called = true; return '{}'; } };
    setPaypalDeps(d);
    expect(await paypalRefundExecutor({ ...req, paypalCaptureId: undefined })).toEqual({});
    expect(called).toBe(false);
  });

  it('refunds the capture with an idempotency key derived from the refund id', async () => {
    const d = makeTestDeps();
    const calls: any[] = [];
    const ids: (string | undefined)[] = [];
    d.toolkit = () => createToolkitRunner({
      tools: (ctx) => { ids.push(ctx?.requestId); return { create_refund: { execute: async (a: any) => { calls.push(a); return JSON.stringify({ id: 'REF7', status: 'COMPLETED' }); } } }; },
    });
    setPaypalDeps(d);
    expect(await paypalRefundExecutor({ ...req, paypalCaptureId: 'CAP1' })).toEqual({ paypalRefundId: 'REF7' });
    expect(calls[0]).toMatchObject({ capture_id: 'CAP1', amount: { currency_code: 'USD', value: '95.00' }, note_to_payer: 'Refund for order NP-10231' });
    expect(ids).toContain('mirage-refund-rf1');
  });

  it('throws when PayPal refuses, so A leaves the refund unexecuted', async () => {
    const d = makeTestDeps();
    d.toolkitTools.create_refund = { execute: async () => JSON.stringify({ error: { message: 'CAPTURE_FULLY_REFUNDED' } }) };
    setPaypalDeps(d);
    await expect(paypalRefundExecutor({ ...req, paypalCaptureId: 'CAP1' })).rejects.toThrow(/CAPTURE_FULLY_REFUNDED/);
  });
});
