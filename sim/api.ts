// Thin HTTP client for the Mirage server. The sim drives the server ONLY through the API in shared/api.ts,
// exactly like a browser would (plus the merchant dashboard endpoints for scoring).
import type {
  ApprovedReq, ApprovedRes, CheckoutReq, CheckoutRes, CreateSessionReq, CreateSessionRes, ListProductsRes,
  SendMessageRes,
} from '../shared/api';
import type { SimRun, StoreId } from '../shared/types';
import type { SessionDetail } from './types';

export class ApiError extends Error {
  constructor(readonly status: number, readonly body: string, readonly path: string) {
    super(`${path} -> HTTP ${status}: ${body.slice(0, 300)}`);
  }
}

export class MirageApi {
  constructor(readonly baseUrl: string, private readonly fetchImpl: typeof fetch = fetch) {}

  private async req<T>(method: 'GET' | 'POST', path: string, body?: unknown, extraHeaders: Record<string, string> = {}): Promise<T> {
    const res = await this.fetchImpl(new URL(path, this.baseUrl), {
      method,
      headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...extraHeaders },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new ApiError(res.status, text, path);
    return (text ? JSON.parse(text) : {}) as T;
  }

  listProducts(storeId: StoreId) {
    return this.req<ListProductsRes>('GET', `/api/stores/${storeId}/products`);
  }
  createSession(body: CreateSessionReq) {
    return this.req<CreateSessionRes>('POST', '/api/sessions', body);
  }
  sendMessage(sessionId: string, content: string) {
    return this.req<SendMessageRes>('POST', `/api/sessions/${encodeURIComponent(sessionId)}/messages`, { content });
  }
  /** realPaypal: ask for a real sandbox PayPal order (header x-mirage-real-paypal: 1), used with --real-approval. */
  checkout(body: CheckoutReq, opts: { realPaypal?: boolean } = {}) {
    return this.req<CheckoutRes>('POST', '/api/checkout', body, opts.realPaypal ? { 'x-mirage-real-paypal': '1' } : {});
  }
  approved(orderId: string, body: ApprovedReq) {
    return this.req<ApprovedRes>('POST', `/api/checkout/${encodeURIComponent(orderId)}/approved`, body);
  }
  sessionDetail(sessionId: string) {
    return this.req<SessionDetail>('GET', `/api/dashboard/sessions/${encodeURIComponent(sessionId)}`);
  }
  /** POST /api/dashboard/sim-runs (Workstream A). Never throws: the JSON file is the source of truth. */
  async postSimRuns(runs: SimRun[]): Promise<{ ok: boolean; status: number; error?: string }> {
    try {
      await this.req('POST', '/api/dashboard/sim-runs', { runs });
      return { ok: true, status: 200 };
    } catch (e) {
      if (e instanceof ApiError) return { ok: false, status: e.status, error: e.message };
      return { ok: false, status: 0, error: (e as Error).message };
    }
  }
}
