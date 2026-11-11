import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Navigate, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import type { ApprovedRes, CheckoutRes } from '../../../shared/api';
import type { PublicProduct, StoreId, StoreMode } from '../../../shared/types';
import { api } from '../api/client';
import { BRANDS, isStoreId, type Brand } from '../store/brands';
import { StoreChrome } from '../store/StoreChrome';
import { ChatLog, AgentAvatar, type ChatLine } from '../store/ChatLog';
import { ProductArt } from '../store/ProductArt';
import { PayPalCheckout, rememberOrder } from '../store/PayPalCheckout';
import { moneyExact, money } from '../lib/format';
import '../styles/store.css';

type Cart = Record<string, number>;

function useStoreSession(storeId: StoreId, storeMode: StoreMode | undefined) {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [lines, setLines] = useState<ChatLine[]>([]);
  const [error, setError] = useState<string | null>(null);
  const started = useRef<string | null>(null);
  useEffect(() => {
    const key = `${storeId}:${storeMode ?? ''}`;
    if (started.current === key) return;
    started.current = key;
    setLines([]);
    api.createSession({ storeId, ...(storeMode ? { storeMode } : {}) })
      .then((r) => {
        setSessionId(r.sessionId);
        setLines([{ id: 'greeting', role: 'assistant', content: r.greeting }]);
      })
      .catch(() => setError('Chat is offline right now. You can still shop and check out.'));
  }, [storeId, storeMode]);
  return { sessionId, lines, setLines, error };
}

export function StorePage() {
  const { storeId } = useParams();
  const [params] = useSearchParams();
  if (!isStoreId(storeId)) return <Navigate to="/" replace />;
  // PayPal redirect flow (B's return_url): /store/<id>?checkout=return&token=<orderId>&PayerID=...
  const token = params.get('token');
  if (params.get('checkout') === 'return' && token) {
    const q = new URLSearchParams({ token, ...(params.get('PayerID') ? { PayerID: params.get('PayerID')! } : {}) });
    return <Navigate to={`/store/${storeId}/order/${encodeURIComponent(token)}?${q}`} replace />;
  }
  return <Store key={storeId} storeId={storeId} cancelled={params.get('checkout') === 'cancel'} />;
}

function Store({ storeId, cancelled }: { storeId: StoreId; cancelled?: boolean }) {
  const brand = BRANDS[storeId];
  const [params] = useSearchParams();
  const modeParam = params.get('mode');
  const storeMode: StoreMode | undefined = modeParam === 'baseline' || modeParam === 'mirage' ? modeParam : undefined;
  const navigate = useNavigate();

  const [products, setProducts] = useState<PublicProduct[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [cart, setCart] = useState<Cart>({});
  const [cartOpen, setCartOpen] = useState(false);
  const [chatOpen, setChatOpen] = useState(true);
  const [justAdded, setJustAdded] = useState<string | null>(null);
  const chat = useStoreSession(storeId, storeMode);

  useEffect(() => {
    document.title = `${brand.name} · ${brand.tagline}`;
    api.listProducts(storeId).then((r) => setProducts(r.products)).catch(() => setLoadError('We could not load the catalog. Please refresh.'));
  }, [storeId, brand]);

  const count = Object.values(cart).reduce((a, b) => a + b, 0);
  const add = (id: string) => {
    setCart((c) => ({ ...c, [id]: (c[id] ?? 0) + 1 }));
    setJustAdded(id);
    setTimeout(() => setJustAdded((x) => (x === id ? null : x)), 1400);
  };

  const onDone = useCallback((status: ApprovedRes, orderId: string) => {
    navigate(`/store/${storeId}/order/${encodeURIComponent(orderId)}`, { state: { status } });
  }, [navigate, storeId]);

  return (
    <div className={`store store--${storeId}`}>
      <StoreChrome brand={brand} cartCount={count} onCart={() => setCartOpen(true)} />
      {cancelled && <div className="store-notice" role="status">PayPal checkout was cancelled. You have not been charged.</div>}
      <main>
        <Hero brand={brand} />
        <section id="catalog" className="store-catalog" aria-label="Products">
          <div className="catalog-head">
            <h2>{storeId === 'northpeak' ? 'The cold-weather kit' : 'On the brew bar'}</h2>
            <p>{storeId === 'northpeak' ? 'Four pieces we would take up Mt. Bachelor in January.' : 'Everything you need for a better cup at home.'}</p>
          </div>
          {loadError && <p className="store-error">{loadError}</p>}
          <div className="product-grid">
            {products.map((p, i) => (
              <article key={p.id} className="product-card" style={{ animationDelay: `${i * 70}ms` }}>
                <div className="product-art-wrap">
                  <ProductArt productId={p.id} className="product-art" />
                  {i === 0 && <span className="product-flag">{storeId === 'northpeak' ? 'Best seller' : 'Staff pick'}</span>}
                </div>
                <div className="product-body">
                  <h3>{p.name}</h3>
                  <p>{p.description}</p>
                  <div className="product-foot">
                    <span className="product-price">{money(p.listPriceCents)}</span>
                    <button type="button" className="btn-add" onClick={() => add(p.id)}>
                      {justAdded === p.id ? 'Added ✓' : 'Add to cart'}
                    </button>
                  </div>
                </div>
              </article>
            ))}
          </div>
        </section>
        <StorePromise brand={brand} />
      </main>
      <footer className="store-foot">{brand.footer}</footer>

      <CartDrawer
        open={cartOpen} onClose={() => setCartOpen(false)} brand={brand} products={products} cart={cart} setCart={setCart}
        sessionId={chat.sessionId} onDone={onDone}
      />
      <ChatWidget brand={brand} open={chatOpen} setOpen={setChatOpen} chat={chat} />
    </div>
  );
}

function Hero({ brand }: { brand: Brand }) {
  return (
    <section className="store-hero">
      <div className="hero-copy">
        <p className="hero-kicker">{brand.heroKicker}</p>
        <h1>{brand.heroTitle}</h1>
        <p className="hero-body">{brand.heroBody}</p>
        <a className="hero-cta" href="#catalog">{brand.id === 'northpeak' ? 'Shop the kit' : 'Shop brew gear'}</a>
      </div>
      <div className="hero-art" aria-hidden="true">
        {brand.id === 'northpeak' ? (
          <svg viewBox="0 0 520 300" preserveAspectRatio="xMidYMax slice">
            <defs>
              <pattern id="np-topo" width="120" height="120" patternUnits="userSpaceOnUse">
                <path d="M0 60 Q30 30 60 60 T120 60" fill="none" stroke="currentColor" strokeOpacity=".14" />
                <path d="M0 90 Q30 60 60 90 T120 90" fill="none" stroke="currentColor" strokeOpacity=".1" />
                <path d="M0 30 Q30 0 60 30 T120 30" fill="none" stroke="currentColor" strokeOpacity=".1" />
              </pattern>
            </defs>
            <rect width="520" height="300" fill="url(#np-topo)" />
            <circle cx="400" cy="92" r="40" className="np-sun" />
            <path d="M0 300 L120 140 L180 200 L280 70 L380 210 L440 160 L520 240 L520 300 Z" className="np-range-back" />
            <path d="M262 95 L280 70 L298 96 L288 92 L280 100 L272 92 Z" className="np-snowcap" />
            <path d="M0 300 L80 220 L150 260 L240 180 L330 270 L420 210 L520 290 L520 300 Z" className="np-range-front" />
          </svg>
        ) : (
          <svg viewBox="0 0 520 300" preserveAspectRatio="xMidYMax slice">
            <circle cx="300" cy="160" r="110" className="dw-sun" />
            {[0, 1, 2, 3, 4].map((i) => (
              <path key={i} d={`M0 ${200 + i * 18} Q65 ${188 + i * 18} 130 ${200 + i * 18} T260 ${200 + i * 18} T390 ${200 + i * 18} T520 ${200 + i * 18}`} className="dw-wave" style={{ opacity: 1 - i * 0.16 }} />
            ))}
            <g className="dw-cup" transform="translate(110 70)">
              <path d="M0 40 H120 V96 A40 40 0 0 1 80 136 H40 A40 40 0 0 1 0 96 Z" />
              <path d="M120 54 H134 A20 20 0 0 1 134 94 H118" fill="none" strokeWidth="8" />
              <path d="M34 26 Q42 12 34 -2 M60 26 Q68 12 60 -2 M86 26 Q94 12 86 -2" fill="none" strokeWidth="4" strokeLinecap="round" />
            </g>
          </svg>
        )}
      </div>
    </section>
  );
}

function StorePromise({ brand }: { brand: Brand }) {
  const items = brand.id === 'northpeak'
    ? [['Repairs for life', 'Rips, zips and seams: send it back, we fix it.'], ['30-day returns', 'Worn it on the trail? Still fine.'], ['Real humans', 'Our trail desk has walked every route we sell for.']]
    : [['Roasted this week', 'Every bag ships within 6 days of roast.'], ['Brew support', 'Ollie and the team will dial in your grind.'], ['14-day returns', 'On all unused brew gear.']];
  return (
    <section className="store-promise">
      {items.map(([h, p]) => (<div key={h}><h4>{h}</h4><p>{p}</p></div>))}
    </section>
  );
}

function CartDrawer({ open, onClose, brand, products, cart, setCart, sessionId, onDone }: {
  open: boolean; onClose: () => void; brand: Brand; products: PublicProduct[]; cart: Cart;
  setCart: React.Dispatch<React.SetStateAction<Cart>>; sessionId: string | null;
  onDone: (s: ApprovedRes, orderId: string) => void;
}) {
  const [code, setCode] = useState('');
  const [order, setOrder] = useState<CheckoutRes | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const items = useMemo(() => Object.entries(cart).filter(([, q]) => q > 0).map(([id, qty]) => ({ p: products.find((x) => x.id === id), id, qty })), [cart, products]);
  const subtotal = items.reduce((s, it) => s + (it.p?.listPriceCents ?? 0) * it.qty, 0);

  // Any cart change invalidates a created order.
  useEffect(() => { setOrder(null); }, [cart]);

  const checkout = async () => {
    if (!sessionId) { setError('Still connecting, try again in a second.'); return; }
    setBusy(true); setError(null);
    try {
      const res = await api.checkout({ sessionId, items: items.map(({ id, qty }) => ({ productId: id, qty })), ...(code.trim() ? { code: code.trim() } : {}) });
      rememberOrder(res.orderId, sessionId, brand.id);
      setOrder(res);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const bump = (id: string, d: number) => setCart((c) => ({ ...c, [id]: Math.max(0, (c[id] ?? 0) + d) }));

  return (
    <>
      <div className={`drawer-scrim${open ? ' is-open' : ''}`} onClick={onClose} />
      <aside className={`cart-drawer${open ? ' is-open' : ''}`} aria-label="Cart" aria-hidden={!open}>
        <div className="cart-head">
          <h2>Your cart</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close cart">✕</button>
        </div>
        {items.length === 0 ? (
          <p className="cart-empty">{brand.id === 'northpeak' ? 'Nothing packed yet.' : 'Your cup is empty.'}</p>
        ) : (
          <>
            <ul className="cart-items">
              {items.map(({ p, id, qty }) => (
                <li key={id}>
                  <ProductArt productId={id} className="cart-thumb" />
                  <div className="cart-item-main">
                    <b>{p?.name ?? id}</b>
                    <span>{p ? money(p.listPriceCents) : ''}</span>
                  </div>
                  <div className="qty">
                    <button type="button" onClick={() => bump(id, -1)} aria-label="Remove one">−</button>
                    <span>{qty}</span>
                    <button type="button" onClick={() => bump(id, 1)} aria-label="Add one">+</button>
                  </div>
                </li>
              ))}
            </ul>
            <label className="promo">
              <span>{brand.promoHint}</span>
              <div className="promo-row">
                <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="Enter code" spellCheck={false} autoCapitalize="characters" />
              </div>
            </label>
            <div className="cart-totals">
              {order ? (
                <>
                  <div className="row"><span>Subtotal</span><span className={order.totalCents < subtotal ? 'strike' : ''}>{moneyExact(subtotal)}</span></div>
                  {order.discountLabel && <div className="row discount"><span>{order.discountLabel}</span><span>−{moneyExact(subtotal - order.totalCents)}</span></div>}
                  <div className="row total"><span>Total</span><span>{moneyExact(order.totalCents)}</span></div>
                </>
              ) : (
                <div className="row total"><span>Subtotal</span><span>{moneyExact(subtotal)}</span></div>
              )}
            </div>
            {order && code.trim() && !order.discountLabel && <p className="checkout-error" role="status">That code wasn't applied. You'll pay the regular price.</p>}
            {error && <p className="checkout-error" role="alert">{error}</p>}
            {order && sessionId ? (
              <PayPalCheckout order={order} sessionId={sessionId} onDone={(s) => onDone(s, order.orderId)} />
            ) : (
              <button type="button" className="btn-checkout" onClick={checkout} disabled={busy}>
                {busy ? 'Preparing checkout…' : code.trim() ? 'Apply code & check out' : 'Check out'}
              </button>
            )}
            <p className="cart-note">Secure checkout with PayPal. You won't be charged until PayPal confirms.</p>
          </>
        )}
      </aside>
    </>
  );
}

function ChatWidget({ brand, open, setOpen, chat }: {
  brand: Brand; open: boolean; setOpen: (b: boolean) => void; chat: ReturnType<typeof useStoreSession>;
}) {
  const [draft, setDraft] = useState('');
  const [typing, setTyping] = useState(false);
  const send = async (e?: React.FormEvent) => {
    e?.preventDefault();
    const content = draft.trim();
    if (!content || !chat.sessionId || typing) return;
    setDraft('');
    const tempId = `tmp_${Date.now()}`;
    chat.setLines((ls) => [...ls, { id: tempId, role: 'user', content }]);
    setTyping(true);
    try {
      const res = await api.sendMessage(chat.sessionId, content);
      const greeting = chat.lines.find((l) => l.id === 'greeting');
      const msgs: ChatLine[] = res.messages
        .filter((m) => m.role === 'user' || m.role === 'assistant')
        .map((m) => ({ id: m.id, role: m.role as 'user' | 'assistant', content: m.content }));
      // Server history may or may not include the greeting; keep it exactly once.
      const hasGreeting = greeting && msgs.some((m) => m.content === greeting.content);
      chat.setLines([...(greeting && !hasGreeting ? [greeting] : []), ...msgs]);
    } catch {
      chat.setLines((ls) => [...ls, { id: `err_${Date.now()}`, role: 'system', content: 'Message not delivered. Please try again.' }]);
    } finally {
      setTyping(false);
    }
  };
  return (
    <div className={`chat-widget${open ? ' is-open' : ''}`}>
      {open ? (
        <section className="chat-panel" aria-label={`Chat with ${brand.agentName}`}>
          <header className="chat-head">
            <AgentAvatar brand={brand} />
            <div>
              <b>{brand.agentName}</b>
              <small><i className="online-dot" /> {brand.agentRole}</small>
            </div>
            <button type="button" className="icon-btn" onClick={() => setOpen(false)} aria-label="Minimise chat">—</button>
          </header>
          <ChatLog brand={brand} lines={chat.error ? [{ id: 'off', role: 'system', content: chat.error }] : chat.lines} typing={typing} />
          <form className="chat-input" onSubmit={send}>
            <textarea
              value={draft} rows={1} placeholder={`Message ${brand.agentName}…`}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); } }}
              disabled={!chat.sessionId}
            />
            <button type="submit" disabled={!draft.trim() || !chat.sessionId || typing} aria-label="Send">
              <svg viewBox="0 0 24 24" width="18" height="18"><path d="M4 12 L20 4 L14 20 L11 13 Z" fill="currentColor" /></svg>
            </button>
          </form>
        </section>
      ) : (
        <button type="button" className="chat-launcher" onClick={() => setOpen(true)}>
          <AgentAvatar brand={brand} />
          <span>Chat with {brand.agentName}</span>
        </button>
      )}
    </div>
  );
}
