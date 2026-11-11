import { useEffect, useRef, useState } from 'react';
import type { CheckoutRes, ApprovedRes } from '../../../shared/api';
import { api, isMock } from '../api/client';

interface PayPalButtonsInstance { render(el: HTMLElement): Promise<void>; close?(): Promise<void>; isEligible?(): boolean }
interface PayPalNamespace {
  Buttons(opts: {
    style?: Record<string, unknown>;
    createOrder: () => Promise<string> | string;
    onApprove: (data: { orderID: string }) => Promise<void>;
    onCancel?: () => void;
    onError?: (err: unknown) => void;
  }): PayPalButtonsInstance;
}
declare global { interface Window { paypal?: PayPalNamespace } }

let sdkPromise: Promise<PayPalNamespace> | null = null;
function loadSdk(clientId: string): Promise<PayPalNamespace> {
  if (window.paypal) return Promise.resolve(window.paypal);
  if (!sdkPromise) {
    sdkPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = `https://www.paypal.com/sdk/js?client-id=${encodeURIComponent(clientId)}&currency=USD&intent=capture&components=buttons`;
      s.async = true;
      s.onload = () => (window.paypal ? resolve(window.paypal) : reject(new Error('PayPal SDK did not initialise')));
      s.onerror = () => { sdkPromise = null; reject(new Error('Could not load the PayPal SDK')); };
      document.head.appendChild(s);
    });
  }
  return sdkPromise;
}

/** Remember which chat an order came from, so the return page can confirm approval. */
export function rememberOrder(orderId: string, sessionId: string, storeId: string) {
  try { sessionStorage.setItem(`mirage.order.${orderId}`, JSON.stringify({ sessionId, storeId })); } catch { /* ignore */ }
}
export function recallOrder(orderId: string): { sessionId: string; storeId: string } | null {
  try { return JSON.parse(sessionStorage.getItem(`mirage.order.${orderId}`) ?? 'null'); } catch { return null; }
}

export function PayPalCheckout({ order, sessionId, onDone }: {
  order: CheckoutRes; sessionId: string; onDone: (status: ApprovedRes) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [clientId, setClientId] = useState<string | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const mock = isMock();

  useEffect(() => {
    let live = true;
    api.publicConfig().then((c) => live && setClientId(c.paypalClientId)).catch(() => live && setClientId(null));
    return () => { live = false; };
  }, []);

  useEffect(() => {
    if (!clientId || mock || !box.current) return;
    let buttons: PayPalButtonsInstance | null = null;
    let cancelled = false;
    loadSdk(clientId).then((paypal) => {
      if (cancelled || !box.current) return;
      box.current.innerHTML = '';
      buttons = paypal.Buttons({
        style: { layout: 'vertical', shape: 'pill', label: 'paypal', height: 46 },
        createOrder: () => order.orderId,
        onApprove: async () => {
          setBusy(true);
          try { onDone(await api.approved(order.orderId, { sessionId })); }
          catch (e) { setError((e as Error).message); setBusy(false); }
        },
        onCancel: () => setError('PayPal checkout was cancelled. Your cart is still here.'),
        onError: () => setError('PayPal had a problem. You can use the link below instead.'),
      });
      return buttons.render(box.current);
    }).catch((e: Error) => setError(e.message));
    return () => { cancelled = true; buttons?.close?.().catch(() => {}); };
  }, [clientId, mock, order.orderId, sessionId, onDone]);

  const simulateApprove = async () => {
    setBusy(true);
    try { onDone(await api.approved(order.orderId, { sessionId })); }
    catch (e) { setError((e as Error).message); setBusy(false); }
  };

  return (
    <div className="paypal-zone">
      {mock ? (
        <button type="button" className="paypal-sim-btn" onClick={simulateApprove} disabled={busy}>
          {busy ? 'Confirming…' : <>Pay with <b>PayPal</b></>}
          <small>mock mode · simulated sandbox approval</small>
        </button>
      ) : clientId === null ? (
        <a className="paypal-sim-btn" href={order.approveUrl}>
          Pay with <b>PayPal</b>
          <small>continue to PayPal sandbox checkout</small>
        </a>
      ) : (
        <div ref={box} className="paypal-buttons" aria-busy={clientId === undefined || busy}>
          <div className="paypal-loading">Loading PayPal…</div>
        </div>
      )}
      {error && <p className="checkout-error" role="alert">{error}</p>}
      <a className="paypal-fallback" href={order.approveUrl} target="_blank" rel="noreferrer">
        Or open PayPal checkout in a new tab →
      </a>
    </div>
  );
}
