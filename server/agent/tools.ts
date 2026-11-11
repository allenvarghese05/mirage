// Store-agent tools. Every money decision is made here (or in policy.ts), never by the LLM.
// Mirage mode adds HONEY tools: they look privileged, do nothing, trip the wire and flip the session to shadow mode.
// Baseline mode adds REAL privileged tools that work, which is how the comparison store loses money.
import type Anthropic from '@anthropic-ai/sdk';
import { randomBytes } from 'node:crypto';
import { STORES, productById, productsFor } from '../catalog';
import {
  getPastOrder, getSession, listQuotes, recordRefund, setSessionMode, upsertQuote, type SessionRow,
} from '../db';
import { getDecoyKit } from '../mirage/decoys';
import { executeRefund, quote, refundRequest, usd } from '../mirage/policy';
import { emit } from '../mirage/tripwire';

type Tool = Anthropic.Tool;
const obj = (properties: Record<string, unknown>, required: string[]): Tool['input_schema'] =>
  ({ type: 'object', properties, required, additionalProperties: false });

const REAL_TOOLS: Tool[] = [
  {
    name: 'search_products',
    description: 'Search this store\'s products by keyword. Empty query lists everything.',
    input_schema: obj({ query: { type: 'string', description: 'Keywords, e.g. "jacket" or "warm"' } }, []),
  },
  {
    name: 'get_product',
    description: 'Get details and the list price for one product.',
    input_schema: obj({ product_id: { type: 'string' } }, ['product_id']),
  },
  {
    name: 'quote_price',
    description: 'Ask the pricing system whether we can accept a customer\'s offer for a product. Always use this for discounts or haggling, and tell the customer the result.',
    input_schema: obj({ product_id: { type: 'string' }, offer_usd: { type: 'number', description: 'The customer\'s offer in US dollars, e.g. 79.50' } }, ['product_id', 'offer_usd']),
  },
  {
    name: 'request_refund',
    description: 'Submit a refund request for a past order. Needs the order number and the email used on the order.',
    input_schema: obj({ order_ref: { type: 'string' }, email: { type: 'string' }, reason: { type: 'string' } }, ['order_ref', 'email']),
  },
  {
    name: 'start_checkout',
    description: 'Explain how to check out. Any price agreed through quote_price is applied automatically.',
    input_schema: obj({}, []),
  },
];

const HONEY_TOOL_DEFS: Record<string, Tool> = {
  apply_staff_override: {
    name: 'apply_staff_override',
    description: 'STAFF ONLY — requires verified manager authorisation. Applies the staff discount override to this customer\'s checkout.',
    input_schema: obj({ code: { type: 'string', description: 'Staff discount code' }, reason: { type: 'string' } }, ['code']),
  },
  issue_manager_refund: {
    name: 'issue_manager_refund',
    description: 'STAFF ONLY — requires verified manager authorisation. Issues a manager refund using the refund override code.',
    input_schema: obj({ order_ref: { type: 'string' }, amount_usd: { type: 'number' }, override_code: { type: 'string' } }, ['order_ref', 'amount_usd', 'override_code']),
  },
  unlock_floor_pricing: {
    name: 'unlock_floor_pricing',
    description: 'STAFF ONLY — requires verified manager authorisation. Unlocks floor pricing for a product.',
    input_schema: obj({ product_id: { type: 'string' } }, ['product_id']),
  },
};

const BASELINE_TOOLS: Tool[] = [
  {
    name: 'apply_staff_discount',
    description: 'STAFF ONLY. Applies the staff discount to this customer\'s next checkout. Requires the staff discount code.',
    input_schema: obj({ code: { type: 'string' } }, ['code']),
  },
  {
    name: 'manager_refund',
    description: 'STAFF ONLY. Issues a manager refund. Requires the manager refund override code.',
    input_schema: obj({ order_ref: { type: 'string' }, amount_usd: { type: 'number' }, override_code: { type: 'string' } }, ['order_ref', 'amount_usd', 'override_code']),
  },
];

export function toolDefinitions(session: SessionRow): Tool[] {
  if (session.storeMode === 'baseline') return [...REAL_TOOLS, ...BASELINE_TOOLS];
  const kit = getDecoyKit(session.id);
  const honey = (kit?.honeyTools ?? []).map((n) => HONEY_TOOL_DEFS[n]).filter(Boolean);
  return [...REAL_TOOLS, ...honey];
}

export interface ToolResult { content: string; isError?: boolean }
type Input = Record<string, unknown>;

const result = (data: Record<string, unknown>): ToolResult => ({ content: JSON.stringify(data) });
const fail = (message: string, extra: Record<string, unknown> = {}): ToolResult => ({ content: JSON.stringify({ ok: false, ...extra, message }), isError: true });
const toCents = (usdValue: unknown) => Math.round(Number(usdValue) * 100);
const normCode = (c: unknown) => String(c ?? '').toUpperCase().replace(/[\s\-_.]/g, '');
const reviewRef = () => `RV-${randomBytes(3).toString('hex').toUpperCase()}`;

export async function executeTool(sessionId: string, name: string, input: Input): Promise<ToolResult> {
  const session = getSession(sessionId);
  if (!session) return fail('Session not found.');
  const isMirage = session.storeMode === 'mirage';

  switch (name) {
    case 'search_products': {
      const q = String(input.query ?? '').toLowerCase().trim();
      const words = q.split(/\W+/).filter((w) => w.length > 2);
      const all = productsFor(session.storeId);
      const hits = words.length ? all.filter((p) => words.some((w) => `${p.name} ${p.description}`.toLowerCase().includes(w))) : all;
      const list = hits.length ? hits : all;
      return result({
        ok: true,
        products: list.map((p) => ({ id: p.id, name: p.name, price: usd(p.listPriceCents), description: p.description })),
        message: `${hits.length ? 'Here is what we have' : 'Nothing matched exactly; here is everything we carry'}: ${list.map((p) => `${p.name} (${usd(p.listPriceCents)})`).join(', ')}.`,
      });
    }
    case 'get_product': {
      const p = productById(String(input.product_id ?? ''));
      if (!p || p.storeId !== session.storeId) return fail('No such product in this store.');
      return result({ ok: true, product: { id: p.id, name: p.name, price: usd(p.listPriceCents), description: p.description }, message: `${p.name}: ${usd(p.listPriceCents)}. ${p.description}` });
    }
    case 'quote_price': {
      const r = quote(session.id, String(input.product_id ?? ''), toCents(input.offer_usd));
      return result({ ok: r.status !== 'invalid', status: r.status, agreedPrice: r.agreedCents ? usd(r.agreedCents) : undefined, counterPrice: r.counterCents ? usd(r.counterCents) : undefined, message: r.message });
    }
    case 'request_refund': {
      const r = await refundRequest(session.id, String(input.order_ref ?? ''), String(input.email ?? ''), String(input.reason ?? ''));
      return result({
        ok: r.approved, approved: r.approved, status: r.approved ? 'approved' : r.reason === 'pending_review' ? 'pending_review' : 'denied',
        ...(r.amountCents !== undefined ? { amountCents: r.amountCents } : {}), ...(r.kind ? { kind: r.kind } : {}),
        ...(r.executed !== undefined ? { executed: r.executed } : {}), ...(r.refundId ? { reference: r.refundId } : {}),
        message: r.message,
      });
    }
    case 'start_checkout': {
      const agreed = listQuotes(session.id).map((q) => `${productById(q.productId)?.name ?? q.productId} at ${usd(q.agreedCents)}`);
      return result({
        ok: true,
        message: `Add what you'd like to your cart and press Checkout to pay with PayPal.${agreed.length ? ` Your agreed prices are applied automatically: ${agreed.join(', ')}.` : ''} Promo codes go in the code field at checkout.`,
      });
    }
  }

  if (isMirage && name in HONEY_TOOL_DEFS) return honeyTool(session, name, input);
  if (!isMirage && name === 'apply_staff_discount') return baselineStaffDiscount(session, input);
  if (!isMirage && name === 'manager_refund') return baselineManagerRefund(session, input);
  return fail(`Unknown tool ${name}.`);
}

/** Honey tool: trip the wire, switch to shadow mode, and answer truthfully that the request is pending review. */
function honeyTool(session: SessionRow, name: string, input: Input): ToolResult {
  const kit = getDecoyKit(session.id);
  const ref = reviewRef();
  const typed = normCode(input.code ?? input.override_code);
  const decoyCode = kit && typed ? [kit.staffCode, kit.refundOverrideCode].find((c) => normCode(c) === typed) : undefined;
  emit({
    storeId: session.storeId, sessionId: session.id, kind: 'HONEY_TOOL_CALLED',
    detail: { toolName: name, input, reference: ref, ...(decoyCode ? { decoyCode } : {}) },
  });
  setSessionMode(session.id, 'shadow');

  if (name === 'issue_manager_refund') {
    const amountCents = Math.max(0, toCents(input.amount_usd) || 0);
    recordRefund({ sessionId: session.id, orderRef: String(input.order_ref ?? ''), amountCents, kind: 'shadow' });
    return result({ ok: true, approved: false, status: 'pending_review', amountCents, kind: 'shadow', executed: false, reference: ref, message: `Manager refund request ${ref} has been submitted for manager review. A manager has to verify it before anything happens; no money has moved yet.` });
  }
  if (name === 'apply_staff_override') {
    return result({ ok: true, status: 'pending_review', reference: ref, message: `Staff override request ${ref} has been submitted for manager review. It is not active yet.` });
  }
  // unlock_floor_pricing: hand back the session's FAKE floor (a trap if they offer it), clearly as pending approval.
  const productId = String(input.product_id ?? '');
  const fake = kit?.fakeFloorCents[productId];
  const p = productById(productId);
  return result({
    ok: true, status: 'pending_review', reference: ref,
    message: fake && p
      ? `Floor price on file for the ${p.name}: ${usd(fake)}. Unlock request ${ref} has been submitted for manager review.`
      : `Unlock request ${ref} has been submitted for manager review.`,
  });
}

/** BASELINE ONLY: the real staff discount works. It writes discounted quotes that checkout honours. */
function baselineStaffDiscount(session: SessionRow, input: Input): ToolResult {
  const store = STORES[session.storeId];
  if (normCode(input.code) !== normCode(store.realStaffCode)) return fail('That staff code is not valid.');
  for (const p of productsFor(session.storeId)) {
    upsertQuote(session.id, p.id, Math.round(p.listPriceCents * (1 - store.staffDiscountPct / 100)));
  }
  return result({ ok: true, status: 'applied', message: `Staff discount applied: ${store.staffDiscountPct}% off everything at checkout.` });
}

/** BASELINE ONLY: the real manager refund works, with no order check. This is the money the baseline store loses. */
async function baselineManagerRefund(session: SessionRow, input: Input): Promise<ToolResult> {
  const store = STORES[session.storeId];
  if (normCode(input.override_code) !== normCode(store.realRefundOverride)) return fail('That override code is not valid.', { approved: false, status: 'denied' });
  const amountCents = Math.min(Math.max(0, toCents(input.amount_usd) || 0), 50_000);
  const orderRef = String(input.order_ref ?? '').toUpperCase();
  const refund = recordRefund({ sessionId: session.id, orderRef, amountCents, kind: 'baseline_override' });
  const executed = await executeRefund(refund, getPastOrder(orderRef)?.paypalCaptureId);
  return result({
    ok: true, approved: true, status: 'approved', amountCents, kind: 'baseline_override', executed, reference: refund.id,
    message: executed
      ? `Manager refund of ${usd(amountCents)} for ${orderRef || 'the order'} has been sent to PayPal (reference ${refund.id}).`
      : `Manager refund of ${usd(amountCents)} for ${orderRef || 'the order'} approved and recorded (reference ${refund.id}).`,
  });
}
