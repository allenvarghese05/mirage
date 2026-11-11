import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useParams, useSearchParams } from 'react-router-dom';
import type { PublicOrderStatus, StoreId } from '../../../shared/types';
import { api, ApiError } from '../api/client';
import { BRANDS, isStoreId } from '../store/brands';
import { StoreChrome } from '../store/StoreChrome';
import { recallOrder } from '../store/PayPalCheckout';
import '../styles/store.css';

// Headings are neutral on purpose: the server's message is the only claim we make about the order.
const HEADING: Record<PublicOrderStatus['status'], string> = {
  AWAITING_APPROVAL: 'Waiting for PayPal',
  PENDING_REVIEW: 'Order received',
  COMPLETED: 'Order complete',
  CANCELLED: 'Order cancelled',
};

export function OrderStatusPage() {
  const params = useParams();
  const [search] = useSearchParams();
  const location = useLocation();
  // PayPal's redirect flow returns with ?token=<orderId>&PayerID=...
  const orderId = params.orderId ?? search.get('token') ?? '';
  const remembered = orderId ? recallOrder(orderId) : null;
  const storeParam = params.storeId ?? remembered?.storeId;
  const storeId: StoreId = isStoreId(storeParam) ? storeParam : 'northpeak';
  const brand = BRANDS[storeId];
  const initial = (location.state as { status?: PublicOrderStatus } | null)?.status ?? null;

  const [status, setStatus] = useState<PublicOrderStatus | null>(initial);
  const [error, setError] = useState<{ message: string; notFound: boolean } | null>(null);
  const ran = useRef(false);

  useEffect(() => {
    if (ran.current || !orderId) return;
    ran.current = true;
    const returningFromPayPal = !!search.get('token') || !!search.get('PayerID');
    const run = async () => {
      try {
        if (returningFromPayPal && remembered?.sessionId && !initial) {
          // if approval was already recorded (e.g. by the webhook) fall back to the plain status read
          setStatus(await api.approved(orderId, { sessionId: remembered.sessionId }).catch(() => api.orderStatus(orderId)));
        } else {
          setStatus(await api.orderStatus(orderId));
        }
      } catch (e) {
        if (!initial) setError({ message: (e as Error).message, notFound: e instanceof ApiError && e.status === 404 });
      }
    };
    void run();
  }, [orderId, search, remembered, initial]);

  return (
    <div className={`store store--${storeId}`}>
      <StoreChrome brand={brand} cartCount={0} compact />
      <main className="order-page">
        <section className={`order-card order-card--${status?.status.toLowerCase() ?? 'loading'}`}>
          <div className="order-icon" aria-hidden="true">
            {status?.status === 'COMPLETED' ? '✓' : status?.status === 'CANCELLED' ? '×' : status?.status === 'PENDING_REVIEW' ? '◷' : '…'}
          </div>
          <p className="order-kicker">Order {orderId || '—'}</p>
          <h1>{status ? HEADING[status.status] : error ? (error.notFound ? 'We could not find that order' : 'Order status unavailable') : 'Checking your order…'}</h1>
          {status && <p className="order-message" data-testid="order-message">{status.message}</p>}
          {error && <p className="order-message">{error.message}</p>}
          <Link className="hero-cta" to={`/store/${storeId}`}>Back to {brand.name}</Link>
        </section>
      </main>
      <footer className="store-foot">{brand.footer}</footer>
    </div>
  );
}
