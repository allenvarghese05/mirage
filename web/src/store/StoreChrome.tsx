import type { Brand } from './brands';

export function Wordmark({ brand }: { brand: Brand }) {
  if (brand.id === 'northpeak') {
    return (
      <span className="np-wordmark" aria-label={brand.name}>
        <svg viewBox="0 0 40 28" className="np-mark" aria-hidden="true">
          <path d="M2 26 L14 8 L20 16 L26 6 L38 26 Z" fill="currentColor" />
          <path d="M23.5 10 L26 6 L28.6 10.4 L26 9 Z" fill="var(--np-snow)" />
        </svg>
        <span className="np-wordmark-text">
          <b>{brand.wordmark[0]}</b>
          <small>{brand.wordmark[1]}</small>
        </span>
      </span>
    );
  }
  return (
    <span className="dw-wordmark" aria-label={brand.name}>
      <svg viewBox="0 0 40 40" className="dw-mark" aria-hidden="true">
        <circle cx="20" cy="20" r="18" fill="none" stroke="currentColor" strokeWidth="1.5" />
        <path d="M9 23 Q14 19 20 23 T31 23" fill="none" stroke="currentColor" strokeWidth="1.6" />
        <path d="M9 28 Q14 24 20 28 T31 28" fill="none" stroke="currentColor" strokeWidth="1.6" opacity=".5" />
        <ellipse cx="20" cy="13" rx="4" ry="5.4" fill="currentColor" />
        <path d="M18.6 8.6 Q21.4 13 19 17.4" stroke="var(--dw-cream)" strokeWidth="1" fill="none" />
      </svg>
      <span className="dw-wordmark-text">
        <b>{brand.wordmark[0]}</b>
        <small>{brand.wordmark[1]}</small>
      </span>
    </span>
  );
}

export function StoreChrome({ brand, cartCount, onCart, compact }: {
  brand: Brand; cartCount: number; onCart?: () => void; compact?: boolean;
}) {
  return (
    <>
      {!compact && <div className="store-ribbon">{brand.ribbon}</div>}
      <header className="store-head">
        <Wordmark brand={brand} />
        <nav className="store-nav" aria-label="Departments">
          {brand.nav.map((n) => <a key={n} href="#catalog">{n}</a>)}
        </nav>
        <button type="button" className="store-cart-btn" onClick={onCart} aria-label={`Cart, ${cartCount} items`}>
          <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
            <path d="M3 4h2l2.4 11.2a1 1 0 0 0 1 .8h9.2a1 1 0 0 0 1-.8L20 8H6.2" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
            <circle cx="9.5" cy="20" r="1.4" fill="currentColor" /><circle cx="17" cy="20" r="1.4" fill="currentColor" />
          </svg>
          <span>Cart</span>
          {cartCount > 0 && <span className="store-cart-count">{cartCount}</span>}
        </button>
      </header>
    </>
  );
}
