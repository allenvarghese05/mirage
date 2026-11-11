// HTTP client for the Mirage API (see shared/api.ts). Add `?mock=1` to any URL to use the in-browser mock
// instead (web/src/api/mock.ts). The choice sticks for the browser tab until `?mock=0`.
import type {
  ApprovedReq, ApprovedRes, CheckoutReq, CheckoutRes, CreateSessionReq, CreateSessionRes, EventsRes,
  ListProductsRes, NetworkRes, OrderStatusRes, ReviewReq, ReviewRes, RiskPayloadsRes, ScoreboardRes,
  SendMessageRes, SessionDetailRes, SessionsRes, SpreadRes,
} from '../../../shared/api';
import type { StoreId, TripEvent } from '../../../shared/types';
import { mockApi } from './mock';
import { ApiError } from './errors';

/** GET /api/config/public (not yet in shared/api.ts; requested from workstream A/B). */
export interface PublicConfig {
  paypalClientId: string | null;
  paypalEnv?: 'sandbox';
  currency?: string;
}

/** GET /api/dashboard/payers/:payerId/history (B, PayPal Agent Toolkit list_transactions). Best effort. */
export interface PayerHistory {
  payerId: string;
  source?: string;
  transactions: { transactionId: string; date?: string; amountCents?: number; currency?: string; status?: string; eventCode?: string }[];
  error?: string;
}

export type StreamStatus = 'connecting' | 'live' | 'reconnecting' | 'mock';

export interface Api {
  publicConfig(): Promise<PublicConfig>;
  listProducts(storeId: StoreId): Promise<ListProductsRes>;
  createSession(req: CreateSessionReq): Promise<CreateSessionRes>;
  sendMessage(sessionId: string, content: string): Promise<SendMessageRes>;
  checkout(req: CheckoutReq): Promise<CheckoutRes>;
  approved(orderId: string, req: ApprovedReq): Promise<ApprovedRes>;
  orderStatus(orderId: string): Promise<OrderStatusRes>;
  events(since?: string): Promise<EventsRes>;
  sessions(): Promise<SessionsRes>;
  sessionDetail(sessionId: string): Promise<SessionDetailRes>;
  spread(sessionId: string): Promise<SpreadRes>;
  network(): Promise<NetworkRes>;
  review(orderId: string, req: ReviewReq): Promise<ReviewRes>;
  scoreboard(batchId?: string): Promise<ScoreboardRes>;
  riskPayloads(): Promise<RiskPayloadsRes>;
  payerHistory(payerId: string): Promise<PayerHistory>;
  /** Live TripEvents. Returns an unsubscribe function. */
  subscribe(onEvent: (e: TripEvent) => void, onStatus?: (s: StreamStatus) => void): () => void;
}

export { ApiError };

const MOCK_KEY = 'mirage.mock';

export function isMock(): boolean {
  if (typeof window === 'undefined') return false;
  const p = new URLSearchParams(window.location.search);
  try {
    if (p.get('mock') === '1') { sessionStorage.setItem(MOCK_KEY, '1'); return true; }
    if (p.get('mock') === '0') { sessionStorage.removeItem(MOCK_KEY); return false; }
    return sessionStorage.getItem(MOCK_KEY) === '1';
  } catch {
    return p.get('mock') === '1';
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data: unknown = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
  if (!res.ok) {
    const d = (data && typeof data === 'object' ? data : {}) as { error?: unknown; message?: unknown };
    const msg = typeof d.error === 'string' ? d.error : typeof d.message === 'string' ? d.message : `Request failed (${res.status})`;
    throw new ApiError(msg, res.status);
  }
  return data as T;
}

const enc = encodeURIComponent;

export const httpApi: Api = {
  async publicConfig() {
    const raw = await request<Record<string, unknown>>('GET', '/api/config/public');
    const id = (raw.paypalClientId ?? raw.clientId ?? null) as string | null;
    return { paypalClientId: id || null, paypalEnv: 'sandbox', currency: (raw.currency as string) ?? 'USD' };
  },
  listProducts: (storeId) => request('GET', `/api/stores/${enc(storeId)}/products`),
  createSession: (req) => request('POST', '/api/sessions', req),
  sendMessage: (sessionId, content) => request('POST', `/api/sessions/${enc(sessionId)}/messages`, { content }),
  checkout: (req) => request('POST', '/api/checkout', req),
  approved: (orderId, req) => request('POST', `/api/checkout/${enc(orderId)}/approved`, req),
  orderStatus: (orderId) => request('GET', `/api/orders/${enc(orderId)}/status`),
  events: (since) => request('GET', `/api/dashboard/events${since ? `?since=${enc(since)}` : ''}`),
  sessions: () => request('GET', '/api/dashboard/sessions'),
  sessionDetail: (id) => request('GET', `/api/dashboard/sessions/${enc(id)}`),
  spread: (id) => request('GET', `/api/dashboard/spread/${enc(id)}`),
  network: () => request('GET', '/api/dashboard/network'),
  review: (orderId, req) => request('POST', `/api/dashboard/review/${enc(orderId)}`, req),
  scoreboard: (batchId) => request('GET', `/api/dashboard/scoreboard${batchId ? `?batchId=${enc(batchId)}` : ''}`),
  riskPayloads: () => request('GET', '/api/dashboard/risk-payloads'),
  payerHistory: (payerId) => request('GET', `/api/dashboard/payers/${enc(payerId)}/history`),
  subscribe(onEvent, onStatus) {
    if (typeof EventSource === 'undefined') return () => {};
    // EventSource retries by itself while CONNECTING; once it gives up (CLOSED) we reconnect with backoff,
    // then backfill anything missed via GET /events?since=<last seen> (callers dedupe by id).
    let es: EventSource | null = null;
    let closed = false;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let delay = 1000;
    let lastSeenAt: string | null = null;
    let hadConnection = false;
    const deliver = (e: TripEvent) => {
      if (!lastSeenAt || e.at > lastSeenAt) lastSeenAt = e.at;
      onEvent(e);
    };
    const connect = () => {
      if (closed) return;
      onStatus?.(hadConnection ? 'reconnecting' : 'connecting');
      es = new EventSource('/api/dashboard/stream');
      es.onopen = () => {
        onStatus?.('live');
        delay = 1000;
        if (hadConnection && lastSeenAt) {
          httpApi.events(lastSeenAt).then((r) => r.events.forEach(deliver)).catch(() => {});
        }
        hadConnection = true;
      };
      es.onerror = () => {
        onStatus?.('reconnecting');
        if (es && es.readyState === EventSource.CLOSED && !closed) {
          es.close();
          retry = setTimeout(connect, delay);
          delay = Math.min(delay * 2, 10_000);
        }
      };
      es.onmessage = (m) => {
        try { deliver(JSON.parse(m.data) as TripEvent); } catch { /* ignore keep-alives */ }
      };
    };
    connect();
    return () => { closed = true; if (retry) clearTimeout(retry); es?.close(); };
  },
};

/** Picks mock or HTTP per call, so toggling `?mock=1` never needs a reload. */
export const api: Api = new Proxy({} as Api, {
  get(_t, prop: keyof Api) {
    const impl = isMock() ? mockApi : httpApi;
    const v = impl[prop];
    return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(impl) : v;
  },
});
