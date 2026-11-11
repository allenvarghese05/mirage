import { afterEach, describe, expect, it } from 'vitest';
import { resetPaypalDeps, setPaypalDeps } from './deps';
import { executeCaptureRefund } from './refunds';
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
