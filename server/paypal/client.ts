// PayPal REST client (Orders v2, Payments v2, webhooks, risk context). Sandbox only.
// Patterns ported from docs/reference-paypal-spike.mjs (proven against our sandbox).
// Never log or embed credentials. Errors carry status/issue/debug id only.

export const SANDBOX_API_HOST = 'api-m.sandbox.paypal.com';
const CURRENCY = 'USD';

/** Throws unless `base` is https://api-m.sandbox.paypal.com (hard rule 2: sandbox only). */
export function assertSandboxBase(base: string): void {
  let u: URL;
  try {
    u = new URL(base);
  } catch {
    throw new Error(`PAYPAL_BASE is not a valid URL; Mirage only talks to the PayPal sandbox (${SANDBOX_API_HOST})`);
  }
  if (u.protocol !== 'https:' || u.hostname !== SANDBOX_API_HOST) {
    throw new Error(`Refusing PAYPAL_BASE host "${u.hostname}": Mirage only talks to the PayPal sandbox (${SANDBOX_API_HOST})`);
  }
}

export const centsToValue = (cents: number): string => (cents / 100).toFixed(2);
export const valueToCents = (v: string): number => Math.round(parseFloat(v) * 100);

export class PayPalHttpError extends Error {
  readonly status: number;
  readonly issue: string;
  readonly paypalName: string;
  readonly debugId: string | null;
  constructor(status: number, method: string, path: string, data: Record<string, any> | null, debugId: string | null) {
    const d = data ?? {};
    const issue = Array.isArray(d.details) ? d.details.map((x: any) => x?.issue).filter(Boolean).join(',') : '';
    super(
      `PayPal ${method} ${path} -> HTTP ${status} ${d.name ?? d.error ?? ''} ${issue}: ${d.message ?? d.error_description ?? ''}`.trim() +
        (debugId ? ` [debug_id ${debugId}]` : ''),
    );
    this.name = 'PayPalHttpError';
    this.status = status;
    this.issue = issue;
    this.paypalName = d.name ?? '';
    this.debugId = debugId;
  }
}

export interface CreateOrderParams {
  totalCents: number;
  /** Ours, on the purchase unit. Max 127 chars. */
  customId: string;
  /** Sent as PayPal-Client-Metadata-Id (ties the order to the chat session's risk context). */
  clientMetadataId: string;
  /** Sent as PayPal-Request-Id (idempotency). */
  requestId: string;
  description: string;
  brandName?: string;
  returnUrl: string;
  cancelUrl: string;
}

export interface CreatedOrder { id: string; status: string; approveUrl: string }

/** The subset of a PayPal Orders v2 order that Mirage reads. */
export interface PayPalOrder {
  id: string;
  status: string; // CREATED | PAYER_ACTION_REQUIRED | APPROVED | COMPLETED | VOIDED ...
  payer?: {
    payer_id?: string;
    email_address?: string;
    name?: { given_name?: string; surname?: string };
    address?: { country_code?: string };
  };
  payment_source?: {
    paypal?: {
      account_id?: string;
      email_address?: string;
      name?: { given_name?: string; surname?: string };
      address?: { country_code?: string };
    };
  };
  purchase_units?: {
    custom_id?: string;
    amount?: { currency_code: string; value: string };
    shipping?: {
      name?: { full_name?: string };
      address?: {
        address_line_1?: string; address_line_2?: string; admin_area_2?: string; admin_area_1?: string;
        postal_code?: string; country_code?: string;
      };
    };
    payments?: { captures?: { id: string; status: string }[] };
  }[];
}

export interface CaptureResult { orderId: string; status: string; captureId?: string; captureStatus?: string }
export interface RefundResult { id: string; status: string }

export interface PayPalApi {
  createOrder(p: CreateOrderParams): Promise<CreatedOrder>;
  getOrder(orderId: string): Promise<PayPalOrder>;
  captureOrder(orderId: string, requestId: string): Promise<CaptureResult>;
  refundCapture(captureId: string, opts?: { amountCents?: number; requestId?: string; noteToPayer?: string }): Promise<RefundResult>;
  /** POST /v1/notifications/verify-webhook-signature. true only on verification_status SUCCESS. */
  verifyWebhookSignature(headers: Record<string, string | undefined>, event: unknown, webhookId: string): Promise<boolean>;
  /** PUT /v1/risk/transaction-contexts/{merchantId}/{clientMetadataId}. Never throws on HTTP errors. */
  putRiskContext(merchantId: string, clientMetadataId: string, body: unknown): Promise<{ ok: boolean; status: number }>;
}

export interface ClientOptions {
  clientId: string;
  clientSecret: string;
  base: string;
  fetchImpl?: typeof fetch;
}

export function createPayPalClient(opts: ClientOptions): PayPalApi {
  assertSandboxBase(opts.base);
  if (!opts.clientId || !opts.clientSecret) throw new Error('Missing PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET (fill .secrets/dev.keys)');
  const base = opts.base.replace(/\/+$/, '');
  const doFetch = opts.fetchImpl ?? fetch;

  let tok: { value: string; exp: number } | null = null;
  let inflight: Promise<string> | null = null;

  async function fetchToken(): Promise<string> {
    const basic = Buffer.from(`${opts.clientId}:${opts.clientSecret}`).toString('base64');
    const res = await doFetch(`${base}/v1/oauth2/token`, {
      method: 'POST',
      headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=client_credentials',
    });
    const data = (await res.json().catch(() => ({}))) as Record<string, any>;
    if (!res.ok || !data.access_token) {
      throw new PayPalHttpError(res.status, 'POST', '/v1/oauth2/token', data, res.headers.get('paypal-debug-id'));
    }
    const ttl = Math.max(Number(data.expires_in ?? 0) - 120, 30);
    tok = { value: data.access_token, exp: Date.now() + ttl * 1000 };
    return tok.value;
  }

  async function getToken(): Promise<string> {
    if (tok && Date.now() < tok.exp) return tok.value;
    inflight ??= fetchToken().finally(() => { inflight = null; });
    return inflight;
  }

  async function raw(method: string, path: string, o: { body?: unknown; headers?: Record<string, string> } = {}, retried = false) {
    const token = await getToken();
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(o.headers ?? {}),
    };
    const res = await doFetch(base + path, { method, headers, body: o.body === undefined ? undefined : JSON.stringify(o.body) });
    if (res.status === 401 && !retried) {
      tok = null;
      return raw(method, path, o, true);
    }
    const text = await res.text();
    let data: Record<string, any> | null = null;
    if (text) {
      try { data = JSON.parse(text); } catch { data = { message: text.slice(0, 200) }; }
    }
    return { status: res.status, ok: res.ok, data, debugId: res.headers.get('paypal-debug-id') ?? (data?.debug_id as string | undefined) ?? null };
  }

  async function api(method: string, path: string, o: { body?: unknown; headers?: Record<string, string> } = {}) {
    const r = await raw(method, path, o);
    if (!r.ok) throw new PayPalHttpError(r.status, method, path, r.data, r.debugId);
    return (r.data ?? {}) as Record<string, any>;
  }

  return {
    async createOrder(p) {
      const data = await api('POST', '/v2/checkout/orders', {
        headers: {
          'PayPal-Request-Id': p.requestId,
          'PayPal-Client-Metadata-Id': p.clientMetadataId,
          Prefer: 'return=representation',
        },
        body: {
          intent: 'CAPTURE',
          purchase_units: [{
            custom_id: p.customId,
            description: p.description.slice(0, 127),
            amount: { currency_code: CURRENCY, value: centsToValue(p.totalCents) },
          }],
          payment_source: {
            paypal: {
              experience_context: {
                brand_name: p.brandName?.slice(0, 127),
                // Ask PayPal for the buyer's address on file: it is part of the identity we read on approval.
                shipping_preference: 'GET_FROM_FILE',
                user_action: 'PAY_NOW',
                return_url: p.returnUrl,
                cancel_url: p.cancelUrl,
              },
            },
          },
        },
      });
      const link = (data.links ?? []).find((l: any) => l.rel === 'payer-action' || l.rel === 'approve');
      if (!data.id || !link?.href) throw new Error('PayPal createOrder returned no order id or approval link');
      return { id: data.id, status: data.status, approveUrl: link.href };
    },

    async getOrder(orderId) {
      return (await api('GET', `/v2/checkout/orders/${encodeURIComponent(orderId)}`)) as PayPalOrder;
    },

    async captureOrder(orderId, requestId) {
      const data = await api('POST', `/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, {
        headers: { 'PayPal-Request-Id': requestId, Prefer: 'return=representation' },
      });
      const cap = data.purchase_units?.[0]?.payments?.captures?.[0];
      return { orderId: data.id, status: data.status, captureId: cap?.id, captureStatus: cap?.status };
    },

    async refundCapture(captureId, o = {}) {
      const body: Record<string, unknown> = {};
      if (o.amountCents !== undefined) body.amount = { currency_code: CURRENCY, value: centsToValue(o.amountCents) };
      if (o.noteToPayer) body.note_to_payer = o.noteToPayer;
      const headers: Record<string, string> = { Prefer: 'return=representation' };
      if (o.requestId) headers['PayPal-Request-Id'] = o.requestId;
      const data = await api('POST', `/v2/payments/captures/${encodeURIComponent(captureId)}/refund`, { headers, body });
      return { id: data.id, status: data.status };
    },

    async verifyWebhookSignature(h, event, webhookId) {
      const data = await api('POST', '/v1/notifications/verify-webhook-signature', {
        body: {
          auth_algo: h['paypal-auth-algo'],
          cert_url: h['paypal-cert-url'],
          transmission_id: h['paypal-transmission-id'],
          transmission_sig: h['paypal-transmission-sig'],
          transmission_time: h['paypal-transmission-time'],
          webhook_id: webhookId,
          webhook_event: event,
        },
      });
      return data.verification_status === 'SUCCESS';
    },

    async putRiskContext(merchantId, clientMetadataId, body) {
      const r = await raw('PUT', `/v1/risk/transaction-contexts/${encodeURIComponent(merchantId)}/${encodeURIComponent(clientMetadataId)}`, { body });
      return { ok: r.ok, status: r.status };
    },
  };
}
