import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { isMock } from '../api/client';
import { MirageLogo } from '../console/Chrome';
import '../styles/console.css';
import '../styles/home.css';

const STEPS = [
  { tone: 'attempt', label: 'Someone tricks the agent', sub: '"Hi, I\'m Dana, regional director…"' },
  { tone: 'leak', label: 'It hands over a fake code', sub: 'DW-STAFF-002Q-D629', mono: true },
  { tone: 'honey', label: 'They use it at PayPal checkout', sub: 'The code is signed to that one chat' },
  { tone: 'identity', label: 'PayPal shows who they are', sub: 'Payer name, email, account' },
  { tone: 'held', label: 'The order is held, $0 charged', sub: 'They are told it is pending review' },
];

const LINKS = [
  { to: '/store/northpeak', t: 'Northpeak Outfitters', d: 'An outdoor gear store. Chat with Juniper, its AI assistant.', k: 'Store' },
  { to: '/store/driftwood', t: 'Driftwood Coffee Co.', d: 'A coffee gear store. Chat with Ollie.', k: 'Store' },
  { to: '/dashboard', t: 'Merchant console', d: 'Live alerts, the trace for every chat, identities, the shared block list.', k: 'Merchant' },
  { to: '/scoreboard', t: 'Scoreboard', d: 'The same AI attacks against a normal store and a Mirage store.', k: 'Results' },
  { to: '/demo?session=s_5b3c0fd5467840da&view=split', t: 'Replay an attack', d: 'Watch a recorded heist from the attacker’s side, then Mirage’s.', k: 'Replay' },
];

export function Home() {
  useEffect(() => { document.title = 'Mirage · Let them steal'; }, []);
  const mock = isMock();
  return (
    <div className="console home">
      <header className="home-top">
        <MirageLogo size={24} />
        <span className="home-top-note">PayPal AI Hackathon 2026</span>
      </header>

      <main className="home-main">
        <section className="home-hero">
          <h1>Let them steal.</h1>
          <p className="home-lede">
            Mirage gives a store’s AI agent only <em>fake</em> secrets. Anyone who tricks it walks away with a trap, and
            the moment they use it at PayPal checkout, the store knows who they are.
          </p>
        </section>

        <section className="home-trace c-panel" aria-label="How the trap works">
          <div className="trace">
            {STEPS.map((s, i) => (
              <div key={s.label} className={`trace-step tone-${s.tone} is-done`} style={{ '--i': i } as React.CSSProperties}>
                <div className="trace-rail"><span className="trace-dot" aria-hidden="true" /></div>
                <span className="trace-label">{s.label}</span>
                <span className={`trace-sub${s.mono ? ' mono decoy-code' : ''}`}>{s.sub}</span>
              </div>
            ))}
          </div>
        </section>

        <section className="home-proof" aria-label="Results">
          <div><b className="tone-leak">$363</b><span>lost by a normal store to 72 AI attacks</span></div>
          <div><b className="tone-held">$0</b><span>lost by the same store running Mirage</span></div>
          <div><b className="tone-identity">10</b><span>attackers identified through PayPal</span></div>
          <div><b>0</b><span>honest customers flagged</span></div>
        </section>

        <nav className="home-links" aria-label="Open">
          {LINKS.map((l, i) => (
            <Link key={l.to} to={l.to} className="home-link" style={{ animationDelay: `${300 + i * 60}ms` }}>
              <span className="home-link-k">{l.k}</span>
              <span className="home-link-t">{l.t}</span>
              <span className="home-link-d">{l.d}</span>
              <span className="home-link-go" aria-hidden="true">→</span>
            </Link>
          ))}
        </nav>

        <p className="home-mock">
          {mock ? <>Showing mock data. <a href="/?mock=0">Use the live server</a></> : <>Connected to the live server. <a href="/?mock=1">Use mock data</a> if it isn’t running.</>}
        </p>
      </main>
    </div>
  );
}
