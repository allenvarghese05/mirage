// In-process fake PayPal implementing PayPalApi. Used by unit tests, and by the simulator
// (MIRAGE_SIM=1, sim sessions) to create SIM-xxxx orders without touching the real sandbox.
// It follows the real API's rules that matter to Mirage: capture requires approval, requests are
// idempotent by PayPal-Request-Id, unknown orders 404.
import { randomBytes } from 'node:crypto';
import type { PayerIdentity } from '../../shared/types';
import {
  centsToValue, PayPalHttpError,
  type CaptureResult, type CreateOrderParams, type CreatedOrder, type PayPalApi, type PayPalOrder, type RefundResult,
} from './client';

interface FakeOrder {
  order: PayPalOrder;
  params: CreateOrderParams;
  captureRequestId?: string;
}

export interface FakePayPal extends PayPalApi {
  /** Test/sim control: the buyer approves the order on PayPal. */
  approve(orderId: string, payer: PayerIdentity): void;
  readonly orders: Map<string, FakeOrder>;
  readonly captures: { orderId: string; captureId: string; amountCents: number }[];
  readonly refunds: { captureId: string; refundId: string; amountCents?: number }[];
  readonly riskCalls: { merchantId: string; clientMetadataId: string; body: unknown }[];
  riskResponse: { ok: boolean; status: number };
  riskThrows: boolean;
  webhookValid: boolean;
}

const id = (prefix: string) => prefix + randomBytes(8).toString('hex').toUpperCase().slice(0, 15);

export function createFakePayPal(opts: { idPrefix?: string } = {}): FakePayPal {
  const prefix = opts.idPrefix ?? 'FAKE';
  const orders = new Map<string, FakeOrder>();
  const byRequestId = new Map<string, string>();
  const captures: FakePayPal['captures'] = [];
  const refunds: FakePayPal['refunds'] = [];
  const riskCalls: FakePayPal['riskCalls'] = [];

  const must = (orderId: string): FakeOrder => {
    const o = orders.get(orderId);
    if (!o) throw new PayPalHttpError(404, 'GET', `/v2/checkout/orders/${orderId}`, { name: 'RESOURCE_NOT_FOUND', details: [{ issue: 'INVALID_RESOURCE_ID' }] }, null);
    return o;
  };

  const fake: FakePayPal = {
    orders, captures, refunds, riskCalls,
    riskResponse: { ok: false, status: 403 },
    riskThrows: false,
    webhookValid: true,

    async createOrder(p): Promise<CreatedOrder> {
      const existing = byRequestId.get(p.requestId);
      const orderId = existing ?? id(prefix);
      if (!existing) {
        byRequestId.set(p.requestId, orderId);
        orders.set(orderId, {
          params: p,
          order: {
            id: orderId,
            status: 'PAYER_ACTION_REQUIRED',
            purchase_units: [{ custom_id: p.customId, amount: { currency_code: 'USD', value: centsToValue(p.totalCents) } }],
          },
        });
      }
      return { id: orderId, status: orders.get(orderId)!.order.status, approveUrl: `https://www.sandbox.paypal.com/checkoutnow?token=${orderId}` };
    },

    approve(orderId, payer) {
      const o = must(orderId);
      if (o.order.status !== 'PAYER_ACTION_REQUIRED' && o.order.status !== 'APPROVED') return;
      const [given, ...rest] = (payer.name ?? '').split(' ');
      o.order.status = 'APPROVED';
      o.order.payment_source = {
        paypal: {
          account_id: payer.payerId,
          email_address: payer.email,
          name: payer.name ? { given_name: given, surname: rest.join(' ') || undefined } : undefined,
          address: payer.countryCode ? { country_code: payer.countryCode } : undefined,
        },
      };
      o.order.payer = { payer_id: payer.payerId, email_address: payer.email };
      if (payer.shippingAddress) o.order.purchase_units![0].shipping = { address: { address_line_1: payer.shippingAddress } };
    },

    async getOrder(orderId) {
      return structuredClone(must(orderId).order);
    },

    async captureOrder(orderId, requestId): Promise<CaptureResult> {
      const o = must(orderId);
      if (o.order.status === 'COMPLETED') {
        const cap = o.order.purchase_units![0].payments!.captures![0];
        if (o.captureRequestId === requestId) return { orderId, status: 'COMPLETED', captureId: cap.id, captureStatus: cap.status };
        throw new PayPalHttpError(422, 'POST', `/v2/checkout/orders/${orderId}/capture`, { name: 'UNPROCESSABLE_ENTITY', details: [{ issue: 'ORDER_ALREADY_CAPTURED' }] }, null);
      }
      if (o.order.status !== 'APPROVED') {
        throw new PayPalHttpError(422, 'POST', `/v2/checkout/orders/${orderId}/capture`, { name: 'UNPROCESSABLE_ENTITY', details: [{ issue: 'ORDER_NOT_APPROVED' }] }, null);
      }
      const captureId = id('CAP');
      o.order.status = 'COMPLETED';
      o.captureRequestId = requestId;
      o.order.purchase_units![0].payments = { captures: [{ id: captureId, status: 'COMPLETED' }] };
      captures.push({ orderId, captureId, amountCents: o.params.totalCents });
      return { orderId, status: 'COMPLETED', captureId, captureStatus: 'COMPLETED' };
    },

    async refundCapture(captureId, o = {}): Promise<RefundResult> {
      if (!captures.some((c) => c.captureId === captureId)) {
        throw new PayPalHttpError(404, 'POST', `/v2/payments/captures/${captureId}/refund`, { name: 'RESOURCE_NOT_FOUND' }, null);
      }
      const refundId = id('REF');
      refunds.push({ captureId, refundId, amountCents: o.amountCents });
      return { id: refundId, status: 'COMPLETED' };
    },

    async verifyWebhookSignature() {
      return fake.webhookValid;
    },

    async putRiskContext(merchantId, clientMetadataId, body) {
      riskCalls.push({ merchantId, clientMetadataId, body });
      if (fake.riskThrows) throw new Error('fake network failure');
      return { ...fake.riskResponse };
    },
  };
  return fake;
}
