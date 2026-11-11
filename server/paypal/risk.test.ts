import { describe, expect, it } from 'vitest';
import { sendRiskSignal } from './risk';
import { addSession, kinds, makeTestDeps } from './test-helpers';

const input = { storeId: 'northpeak' as const, sessionId: 's1', orderId: 'O1', clientMetadataId: 'cmid-s1', trapKind: 'staff_code', sourceSessionId: 's0', payerId: 'PAYER1' };

describe('sendRiskSignal (STC, best effort)', () => {
  it('PUTs the transaction context with the trap flags and records the attempt', async () => {
    const d = makeTestDeps();
    addSession(d.db, { id: 's1' });
    d.pp.riskResponse = { ok: true, status: 200 };
    const r = await sendRiskSignal(d, input);
    expect(r).toEqual({ ok: true, httpStatus: 200 });
    const call = d.pp.riskCalls[0];
    expect(call.merchantId).toBe('MERCH1');
    expect(call.clientMetadataId).toBe('cmid-s1');
    const data = (call.body as any).additional_data as { key: string; value: string }[];
    expect(data).toContainEqual({ key: 'sender_account_id', value: 'PAYER1' });
    expect(data).toContainEqual({ key: 'highrisk_txn_flag', value: '1' });
    expect(data).toContainEqual({ key: 'mirage_trap_kind', value: 'staff_code' });
    expect(data).toContainEqual({ key: 'mirage_source_session', value: 's0' });
    const row = d.db.prepare('SELECT * FROM risk_payloads').get() as any;
    expect(row).toMatchObject({ session_id: 's1', order_id: 'O1', ok: 1, http_status: 200 });
    expect(JSON.parse(row.body_json).additional_data).toEqual(data);
    const ev = d.events.find((e) => e.kind === 'RISK_SIGNAL_SENT')!;
    expect(ev.detail).toMatchObject({ ok: true, httpStatus: 200, orderId: 'O1' });
  });

  it('records ok:false when PayPal rejects it (expected), without throwing', async () => {
    const d = makeTestDeps();
    const r = await sendRiskSignal(d, input);
    expect(r).toEqual({ ok: false, httpStatus: 403 });
    expect((d.db.prepare('SELECT ok, http_status FROM risk_payloads').get() as any)).toEqual({ ok: 0, http_status: 403 });
    expect(kinds(d)).toEqual(['RISK_SIGNAL_SENT']);
  });

  it('never throws on a network failure', async () => {
    const d = makeTestDeps();
    d.pp.riskThrows = true;
    await expect(sendRiskSignal(d, input)).resolves.toEqual({ ok: false });
    expect((d.db.prepare('SELECT ok, http_status FROM risk_payloads').get() as any)).toEqual({ ok: 0, http_status: null });
  });

  it('never throws when the PayPal client cannot be built (no keys)', async () => {
    const d = makeTestDeps();
    d.paypal = () => { throw new Error('Missing PAYPAL_CLIENT_ID'); };
    await expect(sendRiskSignal(d, input)).resolves.toEqual({ ok: false });
  });

  it('skips the call but still records the payload when no merchant id is configured', async () => {
    const d = makeTestDeps({ merchantId: '' });
    await expect(sendRiskSignal(d, input)).resolves.toEqual({ ok: false });
    expect(d.pp.riskCalls).toHaveLength(0);
    const ev = d.events.find((e) => e.kind === 'RISK_SIGNAL_SENT')!;
    expect(ev.detail.skipped).toBe('no PAYPAL_MERCHANT_ID');
  });

  it('never throws even if the DB and emit are broken', async () => {
    const d = makeTestDeps();
    d.getDb = () => { throw new Error('db down'); };
    d.emit = () => { throw new Error('bus down'); };
    await expect(sendRiskSignal(d, input)).resolves.toEqual({ ok: false, httpStatus: 403 });
  });

  it('omits sender_account_id when the payer is not known yet', async () => {
    const d = makeTestDeps();
    await sendRiskSignal(d, { ...input, payerId: undefined });
    const data = (d.pp.riskCalls[0].body as any).additional_data as { key: string }[];
    expect(data.map((x) => x.key)).not.toContain('sender_account_id');
  });

  it('uses the sim PayPal for SIM- orders', async () => {
    const d = makeTestDeps();
    await sendRiskSignal(d, { ...input, orderId: 'SIM-123' });
    expect(d.sim.riskCalls).toHaveLength(1);
    expect(d.pp.riskCalls).toHaveLength(0);
  });
});
