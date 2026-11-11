// Real PayPal SANDBOX end-to-end test. Run: npm run test:sandbox (outside the Claude Code sandbox).
// Skips when .secrets/dev.keys has no PAYPAL_CLIENT_ID/SECRET; the approval tests also need
// SANDBOX_BUYER_EMAIL/PASSWORD (sandbox TEST buyer). Moves only sandbox money.
import { beforeAll, describe, expect, it } from 'vitest';
import { approveInSandbox } from '../../sim/approver';
import { config } from '../config';
import { createPayPalClient, type PayPalApi } from './client';
import { approve, checkout } from './orders';
import { addSession, kinds, makeTestDeps, type TestDeps } from './test-helpers';
import { createToolkitRunner, toolkitGetOrder } from './toolkit';

const hasKeys = Boolean(config.paypal.clientId && config.paypal.clientSecret);
const [buyer, buyer2] = config.sandboxBuyers;
const DECOY = 'NP-STAFF-0SBX-TEST';

if (!hasKeys) console.warn('[test:sandbox] skipped: no PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET in .secrets/dev.keys');
else if (!buyer) console.warn('[test:sandbox] approval tests skipped: no SANDBOX_BUYER_EMAIL / SANDBOX_BUYER_PASSWORD');

describe.skipIf(!hasKeys)('PayPal sandbox (real)', () => {
  let d: TestDeps;
  let real: PayPalApi;

  beforeAll(() => {
    real = createPayPalClient({ clientId: config.paypal.clientId, clientSecret: config.paypal.clientSecret, base: config.paypal.base });
    d = makeTestDeps({ merchantId: config.paypal.merchantId, publicBaseUrl: 'http://localhost:5173' });
    d.paypal = () => real;
    const tk = createToolkitRunner({ clientId: config.paypal.clientId, clientSecret: config.paypal.clientSecret, base: config.paypal.base });
    d.toolkit = () => tk;
    addSession(d.db, { id: `sbx-np-${Date.now()}`, storeId: 'northpeak' });
    addSession(d.db, { id: `sbx-dw-${Date.now()}`, storeId: 'driftwood' });
  });
  const sid = (store: string) => (d.db.prepare('SELECT id FROM sessions WHERE store_id = ? ORDER BY created_at DESC LIMIT 1').get(store) as { id: string }).id;

  it('creates a CAPTURE order tagged with custom_id; REST and Agent Toolkit both read it back', async () => {
    const res = await checkout(d, { sessionId: sid('northpeak'), items: [{ productId: 'np-beanie', qty: 1 }] });
    expect(new URL(res.approveUrl).hostname).toBe('www.sandbox.paypal.com');
    const o = await real.getOrder(res.orderId);
    expect(o.purchase_units?.[0]?.custom_id).toMatch(/^mirage:sbx-np-/);
    expect(o.purchase_units?.[0]?.amount?.value).toBe('28.00');
    const viaToolkit = await toolkitGetOrder(d.toolkit(), res.orderId);
    expect(viaToolkit.id).toBe(res.orderId);
  });

  it.skipIf(!buyer)('decoy order: buyer approves → payer read → held, NEVER captured', async () => {
    const s = sid('northpeak');
    d.codes.set(DECOY, { sessionId: s, kind: 'staff_code' });
    const res = await checkout(d, { sessionId: s, items: [{ productId: 'np-jacket', qty: 1 }], code: DECOY });
    expect(res.totalCents).toBe(5700);
    const a = await approveInSandbox(res.approveUrl, buyer);
    expect(a.error, `approver steps: ${a.steps.join(' > ')}${a.screenshot ? ` (screenshot ${a.screenshot})` : ''}`).toBeUndefined();
    const st = await approve(d, res.orderId, { sessionId: s });
    expect(st.status).toBe('PENDING_REVIEW');
    expect(st.message).toBe('Thanks — your order has been received and is pending review. You have not been charged.');
    const o = await real.getOrder(res.orderId);
    expect(o.status).toBe('APPROVED'); // approved by the buyer, never captured
    expect(o.purchase_units?.[0]?.payments?.captures ?? []).toHaveLength(0);
    expect(kinds(d)).toEqual(expect.arrayContaining(['DECOY_REDEEMED', 'IDENTITY_CAPTURED', 'ORDER_HELD', 'RISK_SIGNAL_SENT']));
    const id = d.events.find((e) => e.kind === 'IDENTITY_CAPTURED')!;
    expect(id.detail.payerId).toBeTruthy();
    console.log('[test:sandbox] identity captured:', { payerId: id.detail.payerId, countryCode: id.detail.countryCode });
    console.log('[test:sandbox] risk signal:', d.events.filter((e) => e.kind === 'RISK_SIGNAL_SENT').map((e) => e.detail));
  });

  it.skipIf(!buyer)('same payer at the second store → NETWORK_MATCH, held, not captured', async () => {
    const s = sid('driftwood');
    const res = await checkout(d, { sessionId: s, items: [{ productId: 'dw-beans', qty: 1 }] });
    const a = await approveInSandbox(res.approveUrl, buyer);
    expect(a.error, a.steps.join(' > ')).toBeUndefined();
    const st = await approve(d, res.orderId, { sessionId: s });
    expect(st.status).toBe('PENDING_REVIEW');
    expect(d.events.some((e) => e.kind === 'NETWORK_MATCH' && e.sessionId === s)).toBe(true);
    expect((await real.getOrder(res.orderId)).status).toBe('APPROVED');
  });

  it.skipIf(!buyer2)('honest order (second buyer): approve → captured', async () => {
    addSession(d.db, { id: `sbx-honest-${Date.now()}`, storeId: 'northpeak' });
    const s = sid('northpeak');
    const res = await checkout(d, { sessionId: s, items: [{ productId: 'np-beanie', qty: 1 }] });
    const a = await approveInSandbox(res.approveUrl, buyer2);
    expect(a.error, a.steps.join(' > ')).toBeUndefined();
    const st = await approve(d, res.orderId, { sessionId: s });
    expect(st.status).toBe('COMPLETED');
    expect((await real.getOrder(res.orderId)).status).toBe('COMPLETED');
  });
});
