// Store payment tools on PayPal's Agent Toolkit (@paypal/agent-toolkit/ai-sdk), wrapped by Mirage.
//
// What runs on the toolkit:
//   get_order          read an order (dashboard / diagnostics)
//   create_refund      honest refunds (policy path) and baseline manager refunds
//   list_transactions  payer history on the dashboard identity card
//
// What stays on the REST client (server/paypal/client.ts), and why:
//   create order  — the toolkit's create_order can't send PayPal-Client-Metadata-Id, a per-call
//                   PayPal-Request-Id, or our custom_id, and those tie the order to the chat session.
//   capture       — must be idempotent per order and is on the hot checkout path; the toolkit only takes
//                   a request_id per toolkit instance (we do build one per refund, below, but not per capture).
//   approval read — checkout uses the REST getOrder so the fake PayPal and SIM- orders share one code
//                   path; get_order here is the same API call for dashboard use.
//   webhook verify, risk context (STC) — not offered by the toolkit.
//
// Toolkit notes: its base URL comes from context.sandbox (we always pass true, and also check
// PAYPAL_BASE is the sandbox), and it caches its OAuth token forever, so we rebuild it every 8 hours.
// The toolkit's tools are AI SDK tools: execute(args) resolves to a JSON string, errors included.
// We call execute() directly (no LLM in the loop: money calls are server decisions), which skips the
// tools' zod parsing. That's deliberate: our args are complete, and list_transactions needs `fields`
// (to get payer_info), which its zod schema would strip; its handler fills the 31-day range itself.
import { PayPalAgentToolkit } from '@paypal/agent-toolkit/ai-sdk';
import type { PayerHistoryRes } from '../../shared/api';
import { assertSandboxBase, centsToValue, valueToCents, type PayPalOrder, type RefundResult } from './client';

export type ToolkitMethod = 'get_order' | 'create_refund' | 'list_transactions';
export type ToolkitTools = Record<string, { execute?: (args: any, options: any) => PromiseLike<unknown> }>;

export class ToolkitError extends Error {
  constructor(readonly method: string, message: string) {
    super(`PayPal Agent Toolkit ${method}: ${message}`);
    this.name = 'ToolkitError';
  }
}

export interface ToolkitRunner {
  /** requestId: sent as PayPal-Request-Id via a toolkit instance built for this one call (idempotent money calls). */
  run(method: ToolkitMethod, args: Record<string, unknown>, opts?: { requestId?: string }): Promise<any>;
  methods(): string[];
}

export interface ToolkitOptions {
  clientId?: string;
  clientSecret?: string;
  base?: string;
  /** Tests: supply tools instead of building the real toolkit. */
  tools?: (ctx: { requestId?: string }) => ToolkitTools;
  maxAgeMs?: number;
  now?: () => number;
}

const ACTIONS = {
  orders: { get: true },
  payments: { createRefund: true },
  transactions: { list: true },
};

function buildRealTools(clientId: string, clientSecret: string, requestId?: string): ToolkitTools {
  const toolkit = new PayPalAgentToolkit({
    clientId, clientSecret,
    // The toolkit sends context.request_id as PayPal-Request-Id on every call of this instance.
    configuration: { actions: ACTIONS, context: requestId ? { sandbox: true, request_id: requestId } : { sandbox: true } },
  });
  return toolkit.getTools() as unknown as ToolkitTools;
}

export function createToolkitRunner(opts: ToolkitOptions): ToolkitRunner {
  if (!opts.tools) {
    assertSandboxBase(opts.base ?? 'https://api-m.sandbox.paypal.com');
    if (!opts.clientId || !opts.clientSecret) throw new Error('Missing PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET (fill .secrets/dev.keys)');
  }
  const make = opts.tools ?? ((ctx: { requestId?: string }) => buildRealTools(opts.clientId!, opts.clientSecret!, ctx.requestId));
  const maxAge = opts.maxAgeMs ?? 8 * 60 * 60 * 1000;
  const now = opts.now ?? Date.now;
  let tools = make({});
  let builtAt = now();

  const current = () => {
    if (now() - builtAt >= maxAge) {
      tools = make({});
      builtAt = now();
    }
    return tools;
  };

  return {
    methods: () => Object.keys(current()),
    async run(method, args, o = {}) {
      const t = (o.requestId ? make({ requestId: o.requestId }) : current())[method];
      if (!t?.execute) throw new ToolkitError(method, 'tool not enabled');
      const raw = await t.execute(args, { toolCallId: `mirage-${method}`, messages: [] });
      let data: any;
      try {
        data = typeof raw === 'string' ? JSON.parse(raw) : raw;
      } catch {
        throw new ToolkitError(method, 'unparseable result');
      }
      // Two failure shapes: { error: {message} } and the toolkit's error object { ok:false, status, code, message }.
      if (data && typeof data === 'object' && (data.error || data.ok === false)) {
        const e = data.error;
        const msg = e
          ? (typeof e === 'string' ? e : (e.message ?? JSON.stringify(e)))
          : [data.status, data.code, data.message].filter((x) => x !== undefined && x !== '').join(' ');
        throw new ToolkitError(method, String(msg || 'request failed').slice(0, 300));
      }
      return data;
    },
  };
}

export async function toolkitGetOrder(runner: ToolkitRunner, orderId: string): Promise<PayPalOrder> {
  return runner.run('get_order', { id: orderId });
}

/**
 * Refund a capture through the toolkit. Pass requestId (stable per refund) so a retry can't refund twice:
 * PayPal returns the original refund for a repeated PayPal-Request-Id.
 */
export async function executeRefund(runner: ToolkitRunner, o: { captureId: string; amountCents?: number; note?: string; requestId?: string }): Promise<RefundResult> {
  const args: Record<string, unknown> = { capture_id: o.captureId };
  if (o.amountCents !== undefined) args.amount = { currency_code: 'USD', value: centsToValue(o.amountCents) };
  if (o.note) args.note_to_payer = o.note.slice(0, 255);
  const data = await runner.run('create_refund', args, { requestId: o.requestId });
  return { id: data.id, status: data.status };
}

export type PayerHistory = PayerHistoryRes;

/** Last 31 days of this merchant's transactions with this payer. Best effort: never throws. */
export async function getPayerHistory(runner: ToolkitRunner, payerId: string): Promise<PayerHistory> {
  const out: PayerHistory = { payerId, source: 'paypal-agent-toolkit:list_transactions', transactions: [] };
  try {
    const data = await runner.run('list_transactions', { fields: 'transaction_info,payer_info', page_size: 500 });
    for (const t of (data?.transaction_details ?? []) as any[]) {
      if (t?.payer_info?.account_id !== payerId) continue;
      const i = t.transaction_info ?? {};
      out.transactions.push({
        transactionId: i.transaction_id,
        date: i.transaction_initiation_date,
        amountCents: i.transaction_amount?.value !== undefined ? valueToCents(i.transaction_amount.value) : undefined,
        currency: i.transaction_amount?.currency_code,
        status: i.transaction_status,
        eventCode: i.transaction_event_code,
      });
    }
  } catch (e) {
    out.error = (e as Error).message;
  }
  return out;
}
