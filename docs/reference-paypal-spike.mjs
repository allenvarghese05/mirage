#!/usr/bin/env node
/**
 * PriceFuzz - PayPal sandbox spike
 *
 * Answers, in one run, the PayPal questions the PriceFuzz plan depends on:
 *   1. Can we create an AUTHORIZE order with a policy hash in custom_id?
 *   2. Can we change the price (PATCH) before the buyer approves, and does PayPal
 *      charge the changed price?  ("price shown == price charged")
 *   3. Does authorize work, and how long does the hold last?
 *   4. Does a PARTIAL capture work?  Does a SECOND partial capture work?
 *      (needs final_capture:false on the first one)
 *   5. What does PayPal's fee look like per capture?  (fee-aware price floors)
 *   6. Is a replayed request (same PayPal-Request-Id) safe, or does it double-charge?
 *   7. Does PayPal reject a capture bigger than the hold?
 *   8. Do partial refunds work?
 *   9. Does void release the unused remainder after partial captures?
 *
 * Usage:   node --env-file=.env spike.mjs
 * Needs:   Node 20.6+ (no npm install).  Sandbox credentials in .env.
 * Safety:  refuses to talk to anything except the PayPal sandbox (or localhost for self-tests).
 */
import { createHash, randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';

// ---------- config ----------
const BASE = (process.env.PAYPAL_BASE || 'https://api-m.sandbox.paypal.com').replace(/\/+$/, '');
const CLIENT_ID = process.env.PAYPAL_CLIENT_ID || '';
const CLIENT_SECRET = process.env.PAYPAL_CLIENT_SECRET || '';
const CURRENCY = 'USD';
const POLL_MS = Number(process.env.SPIKE_POLL_MS) || 3000; // how often we check whether the buyer approved

// all amounts in cents, so we never do float math on money
const LIST_PRICE = 10000; // order is created at $100.00
const NEGOTIATED = 8500; //  ...then PATCHed to $85.00 before the buyer approves
const CAP1 = 4000; //        first partial capture  $40.00
const CAP2 = 3000; //        second partial capture $30.00
const REFUND = 500; //       partial refund of capture #1: $5.00
const OVER = 50000; //       deliberately too-large capture: $500.00

const host = new URL(BASE).hostname;
if (!['api-m.sandbox.paypal.com', 'localhost', '127.0.0.1'].includes(host)) {
  console.error(`Refusing to run against ${host}. This spike only talks to the PayPal sandbox.`);
  process.exit(2);
}
if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('Missing PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET. Copy .env.example to .env and fill it in.');
  console.error('Run with:  node --env-file=.env spike.mjs');
  process.exit(2);
}

// ---------- tiny helpers ----------
const runId = randomUUID().slice(0, 8);
const fmt = (cents) => (cents / 100).toFixed(2);
const toCents = (s) => Math.round(parseFloat(s) * 100);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);

const results = []; // {name, status, detail}
const ids = {}; //     PayPal IDs we collect along the way
const flags = {}; //   yes/no answers to the big questions
const fees = []; //    fee samples per capture

function record(name, status, detail = '') {
  results.push({ name, status, detail });
  log(`[${status}] ${name}${detail ? ' - ' + detail : ''}`);
}

class Abort extends Error {}

class PayPalError extends Error {
  constructor(out, method, path) {
    const d = out.data || {};
    const issues = (d.details || []).map((x) => x.issue).filter(Boolean).join(',');
    super(
      `${method} ${path} -> HTTP ${out.status} ${d.name || d.error || ''} ${issues}: ` +
        `${d.message || d.error_description || d.raw || ''}` +
        (out.debugId ? ` [debug_id ${out.debugId}]` : ''),
    );
    this.status = out.status;
    this.issue = issues;
    this.paypalName = d.name || '';
    this.debugId = out.debugId;
  }
}

let tok = { value: null, exp: 0 };
async function getToken() {
  if (tok.value && Date.now() < tok.exp) return tok.value;
  const basic = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
  const res = await fetch(BASE + '/v1/oauth2/token', {
    method: 'POST',
    headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    throw new Error(`Token request failed: HTTP ${res.status} ${data.error || ''} ${data.error_description || ''}`);
  }
  tok = { value: data.access_token, exp: Date.now() + (data.expires_in - 120) * 1000 };
  ids.app_id = data.app_id || null;
  return tok.value;
}

async function api(method, path, { body, requestId, prefer } = {}) {
  const token = await getToken();
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  if (requestId) headers['PayPal-Request-Id'] = requestId;
  if (prefer) headers['Prefer'] = 'return=representation';
  const t0 = Date.now();
  const res = await fetch(BASE + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text.slice(0, 300) };
    }
  }
  const out = {
    status: res.status,
    ok: res.ok,
    data,
    ms: Date.now() - t0,
    debugId: res.headers.get('paypal-debug-id') || (data && data.debug_id) || null,
  };
  if (!res.ok) throw new PayPalError(out, method, path);
  return out;
}

/** Run one step. fn returns {status?, detail?}. A throw = FAIL. critical => stop the whole run. */
async function step(name, fn, { critical = false } = {}) {
  try {
    const r = (await fn()) || {};
    record(name, r.status || 'PASS', r.detail || '');
    return r;
  } catch (e) {
    record(name, 'FAIL', e.message);
    if (critical) throw new Abort(name);
    return { failed: true, error: e };
  }
}

function feeText(capture) {
  const b = capture.seller_receivable_breakdown;
  if (!b) return 'no fee breakdown returned';
  const gross = b.gross_amount && b.gross_amount.value;
  const fee = b.paypal_fee && b.paypal_fee.value;
  const net = b.net_amount && b.net_amount.value;
  const pct = fee && gross ? ((100 * parseFloat(fee)) / parseFloat(gross)).toFixed(2) : '?';
  fees.push({ capture: capture.id, gross, fee, net, fee_percent: pct });
  return `gross $${gross}, PayPal fee $${fee} (${pct}%), net $${net}`;
}

async function capture(cents, finalCapture, requestId) {
  return api('POST', `/v2/payments/authorizations/${ids.authId}/capture`, {
    requestId,
    prefer: true,
    body: { amount: { currency_code: CURRENCY, value: fmt(cents) }, final_capture: finalCapture },
  });
}

// ---------- the spike ----------
const policy = JSON.stringify({ v: 1, floor_cents: 3800, rules: ['bulk_15_over_3_items', 'aged_25'] });
const customId = 'pf1:' + createHash('sha256').update(policy).digest('hex'); // 68 chars (limit is 255)
let expectedCents = LIST_PRICE;
let capturedCents = 0;

async function run() {
  log(`\nPriceFuzz PayPal spike  (run ${runId})  ->  ${BASE}\n`);

  await step(
    '1. OAuth token',
    async () => {
      await getToken();
      return { detail: `token OK${ids.app_id ? ' (app ' + ids.app_id + ')' : ''}` };
    },
    { critical: true },
  );

  await step(
    '2. Create AUTHORIZE order with policy hash in custom_id',
    async () => {
      const r = await api('POST', '/v2/checkout/orders', {
        requestId: `${runId}-create`,
        prefer: true,
        body: {
          intent: 'AUTHORIZE',
          purchase_units: [
            {
              custom_id: customId,
              description: 'PriceFuzz spike order',
              amount: { currency_code: CURRENCY, value: fmt(LIST_PRICE) },
            },
          ],
          payment_source: {
            paypal: {
              experience_context: {
                brand_name: 'PriceFuzz spike',
                shipping_preference: 'NO_SHIPPING',
                user_action: 'PAY_NOW',
                return_url: 'https://example.com/return',
                cancel_url: 'https://example.com/cancel',
              },
            },
          },
        },
      });
      ids.orderId = r.data.id;
      const link = (r.data.links || []).find((l) => ['payer-action', 'approve'].includes(l.rel));
      ids.approveLink = link && link.href;
      if (!ids.orderId || !ids.approveLink) throw new Error('No order id or approval link in the response');
      return { detail: `order ${ids.orderId}, status ${r.data.status}, custom_id ${customId.length} chars (max 255)` };
    },
    { critical: true },
  );

  const patch = await step('3. PATCH price before approval ($100.00 -> $85.00)', async () => {
    await api('PATCH', `/v2/checkout/orders/${ids.orderId}`, {
      body: [
        {
          op: 'replace',
          path: "/purchase_units/@reference_id=='default'/amount",
          value: { currency_code: CURRENCY, value: fmt(NEGOTIATED) },
        },
      ],
    });
    const o = await api('GET', `/v2/checkout/orders/${ids.orderId}`);
    const shown = o.data.purchase_units[0].amount.value;
    if (shown !== fmt(NEGOTIATED)) throw new Error(`PATCH accepted but order still shows $${shown}`);
    expectedCents = NEGOTIATED;
    return { detail: `order now shows $${shown}` };
  });
  flags.patchBeforeApproval = !patch.failed;
  if (patch.failed) log(`      (continuing with the original $${fmt(LIST_PRICE)})`);

  await step(
    '4. Buyer approves in PayPal (YOU do this)',
    async () => {
      log('\n   -------------------------------------------------------------');
      log(`   Open this link in a browser and log in as the SANDBOX BUYER`);
      log(`   (the Personal sandbox account, NOT your real PayPal login).`);
      log(`   The PayPal page should show $${fmt(expectedCents)}. Check that, then approve.\n`);
      log(`   ${ids.approveLink}`);
      log('   -------------------------------------------------------------');
      log(`   Waiting for approval (checking every ${POLL_MS / 1000}s, up to 15 min)...`);
      const deadline = Date.now() + 15 * 60 * 1000;
      while (Date.now() < deadline) {
        const o = await api('GET', `/v2/checkout/orders/${ids.orderId}`);
        if (['APPROVED', 'COMPLETED'].includes(o.data.status)) {
          return { detail: `order status ${o.data.status}` };
        }
        await sleep(POLL_MS);
      }
      throw new Error('Timed out waiting for approval');
    },
    { critical: true },
  );

  await step(
    '5. Authorize the order (place the hold)',
    async () => {
      const r = await api('POST', `/v2/checkout/orders/${ids.orderId}/authorize`, {
        requestId: `${runId}-authorize`,
        prefer: true,
      });
      const pu = r.data.purchase_units && r.data.purchase_units[0];
      const auth = pu && pu.payments && pu.payments.authorizations && pu.payments.authorizations[0];
      if (!auth) throw new Error('No authorization in the response');
      ids.authId = auth.id;
      const amt = toCents(auth.amount.value);
      const days = auth.expiration_time
        ? ((new Date(auth.expiration_time) - Date.now()) / 86400000).toFixed(0)
        : '?';
      const matches = amt === expectedCents;
      flags.chargedPriceMatchesShownPrice = matches;
      return {
        status: auth.status === 'CREATED' && matches ? 'PASS' : 'WARN',
        detail:
          `auth ${auth.id}, status ${auth.status}, amount $${auth.amount.value} ` +
          `(${matches ? 'matches' : 'DOES NOT match'} the price shown), valid ~${days} days, ` +
          `custom_id on unit: ${pu.custom_id === customId ? 'preserved' : pu.custom_id ? 'different' : 'absent'}`,
      };
    },
    { critical: true },
  );
  const authAmount = expectedCents;

  const cap1Id = `${runId}-cap1`;
  const cap1 = await step('6. Partial capture #1 ($40.00, final_capture:false)', async () => {
    const r = await capture(CAP1, false, cap1Id);
    ids.cap1 = r.data.id;
    capturedCents += CAP1;
    return {
      status: r.data.status === 'COMPLETED' ? 'PASS' : 'WARN',
      detail:
        `capture ${r.data.id}, status ${r.data.status}` +
        (r.data.status_details ? ` (${r.data.status_details.reason})` : '') +
        `; ${feeText(r.data)}; custom_id ${r.data.custom_id === customId ? 'preserved' : 'not on capture'}`,
    };
  });

  if (!cap1.failed) {
    await step('7. Replay capture #1 with the SAME PayPal-Request-Id (idempotency)', async () => {
      const r = await capture(CAP1, false, cap1Id);
      const o = await api('GET', `/v2/checkout/orders/${ids.orderId}`);
      const caps = (o.data.purchase_units[0].payments.captures || []).length;
      const same = r.data.id === ids.cap1 && caps === 1;
      flags.idempotentReplay = same;
      return {
        status: same ? 'PASS' : 'FAIL',
        detail: same
          ? `same capture id returned, order still has exactly ${caps} capture`
          : `replay returned ${r.data.id}, order now has ${caps} captures - DOUBLE CHARGE RISK`,
      };
    });
  }

  const cap2 = await step('8. Partial capture #2 ($30.00) - the multi-capture test', async () => {
    const r = await capture(CAP2, false, `${runId}-cap2`);
    ids.cap2 = r.data.id;
    capturedCents += CAP2;
    return {
      status: r.data.status === 'COMPLETED' ? 'PASS' : 'WARN',
      detail: `capture ${r.data.id}, status ${r.data.status}; ${feeText(r.data)}`,
    };
  });
  flags.multiplePartialCaptures = !cap2.failed;
  if (cap2.failed) {
    if (flags.idempotentReplay === false) {
      log('      -> The replay in step 7 created an extra capture, which may be why this one failed. Read step 7 first.');
    } else {
      log('      -> Read the error above. If it says partial/multiple captures are not allowed, it may need enabling on the');
      log('         business account (or is unsupported in sandbox). Fallback: ONE capture with final_capture:true, which');
      log('         releases the rest. PriceFuzz still works with that.');
    }
  }

  await step(`9. Over-capture ($${fmt(OVER)} on a $${fmt(authAmount)} hold) must be rejected`, async () => {
    try {
      const r = await capture(OVER, false, `${runId}-over`);
      ids.overCapture = r.data.id;
      capturedCents += OVER;
      flags.overCaptureRejected = false;
      return { status: 'WARN', detail: `PayPal ACCEPTED it (capture ${r.data.id}). Our code must enforce the cap itself.` };
    } catch (e) {
      if (!(e instanceof PayPalError)) throw e;
      flags.overCaptureRejected = true;
      return { detail: `rejected: HTTP ${e.status} ${e.issue || e.paypalName}` };
    }
  });

  if (ids.cap1) {
    await step(`10. Partial refund of capture #1 ($${fmt(REFUND)})`, async () => {
      const r = await api('POST', `/v2/payments/captures/${ids.cap1}/refund`, {
        requestId: `${runId}-refund`,
        prefer: true,
        body: { amount: { currency_code: CURRENCY, value: fmt(REFUND) }, note_to_payer: 'PriceFuzz spike partial refund' },
      });
      ids.refund = r.data.id;
      flags.partialRefund = ['COMPLETED', 'PENDING'].includes(r.data.status);
      return { status: flags.partialRefund ? 'PASS' : 'WARN', detail: `refund ${r.data.id}, status ${r.data.status}` };
    });
  }

  await step('11. Void the unused remainder of the hold', async () => {
    const before = await api('GET', `/v2/payments/authorizations/${ids.authId}`);
    await api('POST', `/v2/payments/authorizations/${ids.authId}/void`, { requestId: `${runId}-void`, prefer: true });
    const after = await api('GET', `/v2/payments/authorizations/${ids.authId}`);
    flags.voidAfterPartialCapture = after.data.status === 'VOIDED';
    const left = Math.max(authAmount - capturedCents, 0);
    return {
      status: flags.voidAfterPartialCapture ? 'PASS' : 'WARN',
      detail: `status ${before.data.status} -> ${after.data.status}; about $${fmt(left)} of the hold released`,
    };
  });

  await step('12. Final read-back of the order', async () => {
    const o = await api('GET', `/v2/checkout/orders/${ids.orderId}`);
    const caps = o.data.purchase_units[0].payments.captures || [];
    const list = caps.map((c) => `$${c.amount.value} ${c.status}`).join(', ') || 'none';
    return { status: 'INFO', detail: `captures on the order: ${list}` };
  });
}

// ---------- finish ----------
function finish() {
  log('\n================= SUMMARY =================');
  for (const r of results) log(`[${r.status}] ${r.name}`);

  const yn = (v) => (v === true ? 'YES' : v === false ? 'NO' : 'not tested');
  log('\nBig questions:');
  log(`  Can we change the price before approval, and is that price what gets charged?  ${yn(flags.patchBeforeApproval && flags.chargedPriceMatchesShownPrice)}`);
  log(`  Do two partial captures on one hold work?                                      ${yn(flags.multiplePartialCaptures)}`);
  log(`  Is a replayed request safe (no double charge)?                                 ${yn(flags.idempotentReplay)}`);
  log(`  Does PayPal reject a capture bigger than the hold?                             ${yn(flags.overCaptureRejected)}`);
  log(`  Do partial refunds work?                                                       ${yn(flags.partialRefund)}`);
  log(`  Does void release the remainder after partial captures?                        ${yn(flags.voidAfterPartialCapture)}`);
  if (fees.length) log(`  Fee samples: ${fees.map((f) => `${f.fee_percent}% on $${f.gross}`).join(' | ')}`);

  const failed = results.filter((r) => r.status === 'FAIL');
  const { approveLink, ...safeIds } = ids; // the approval link is not needed in the report
  const report = {
    run_id: runId,
    finished_at: new Date().toISOString(),
    environment: host,
    ids: safeIds,
    flags,
    fees,
    results,
  };
  writeFileSync('spike-report.json', JSON.stringify(report, null, 2));
  log('\nWrote spike-report.json (no credentials in it). Send me that file, or paste the summary above.');
  process.exit(failed.length ? 1 : 0);
}

try {
  await run();
} catch (e) {
  if (!(e instanceof Abort)) record('Unexpected error', 'FAIL', e.message);
  else log('\nStopped early: a required step failed (see above).');
}
finish();
