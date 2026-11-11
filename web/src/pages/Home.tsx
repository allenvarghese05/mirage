import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { isMock } from '../api/client';
import { MirageLogo } from '../console/Chrome';
import '../styles/console.css';
import '../styles/home.css';

const TILES = [
  { to: '/store/northpeak', k: 'Store', t: 'Northpeak Outfitters', d: 'Outdoor gear. Agent: Juniper.', cls: 'np' },
  { to: '/store/driftwood', k: 'Store', t: 'Driftwood Coffee Co.', d: 'Coffee gear. Agent: Ollie.', cls: 'dw' },
  { to: '/dashboard', k: 'Merchant', t: 'Security console', d: 'Live alarms, code traces, identities, block list.', cls: 'con' },
  { to: '/scoreboard', k: 'Proof', t: 'Scoreboard', d: 'Normal store vs Mirage across every simulated attack.', cls: 'con' },
  { to: '/demo', k: 'Replay', t: 'Heist replay', d: 'A recorded attack, then REWIND to see Mirage’s side.', cls: 'con' },
];

export function Home() {
  useEffect(() => { document.title = 'Mirage · Let them steal'; }, []);
  const mock = isMock();
  return (
    <div className="console home">
      <main className="home-main">
        <MirageLogo size={44} />
        <h1>Let them steal.</h1>
        <p className="home-lede">
          Mirage gives an AI store agent only fake secrets. Anyone who tricks it walks away with traps that identify them at PayPal checkout.
        </p>
        <nav className="home-tiles">
          {TILES.map((t, i) => (
            <Link key={t.to} to={t.to} className={`home-tile home-tile--${t.cls}`} style={{ animationDelay: `${i * 70}ms` }}>
              <span className="c-kicker">{t.k}</span>
              <b>{t.t}</b>
              <span>{t.d}</span>
            </Link>
          ))}
        </nav>
        <p className="home-mock mono">
          {mock ? <>Mock data is ON for this tab. <a href="/?mock=0">Use the live server</a></> : <>Using the live server. <a href="/?mock=1">Use mock data</a> if it isn’t running.</>}
        </p>
      </main>
    </div>
  );
}
