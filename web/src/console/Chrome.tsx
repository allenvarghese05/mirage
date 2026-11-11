import { Link, NavLink } from 'react-router-dom';
import { isMock } from '../api/client';

export function MirageLogo({ size = 26 }: { size?: number }) {
  return (
    <span className="m-logo">
      <svg viewBox="0 0 32 32" width={size} height={size} aria-hidden="true">
        <path d="M5 21 L16 6 L27 21" stroke="currentColor" strokeWidth="2.6" fill="none" strokeLinejoin="round" />
        <path d="M9 26 L16 16.5 L23 26" stroke="currentColor" strokeOpacity=".4" strokeWidth="2" fill="none" strokeLinejoin="round" strokeDasharray="2.5 2" />
        <path d="M2 23.5 H30" stroke="currentColor" strokeOpacity=".55" strokeWidth="1" />
      </svg>
      <b>MIRAGE</b>
    </span>
  );
}

export function ConsoleTopbar({ children }: { children?: React.ReactNode }) {
  const mock = isMock();
  return (
    <header className="c-top">
      <Link to="/" className="c-brand"><MirageLogo /><span className="c-brand-sub">Merchant console</span></Link>
      <nav className="c-nav">
        <NavLink to="/dashboard">Console</NavLink>
        <NavLink to="/scoreboard">Scoreboard</NavLink>
        <NavLink to="/demo">Replay</NavLink>
        <span className="c-nav-sep" aria-hidden="true" />
        <NavLink to="/store/northpeak">Northpeak store</NavLink>
        <NavLink to="/store/driftwood">Driftwood store</NavLink>
      </nav>
      <div className="c-top-right">
        {mock && <span className="c-mock-tag" title="Remove ?mock=1 (or add ?mock=0) to use the live server">MOCK DATA</span>}
        {children}
      </div>
    </header>
  );
}

/** Tiny alert chime with WebAudio, so we ship no audio files. */
export function chime(kind: 'critical' | 'identity' = 'critical') {
  try {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const notes = kind === 'identity' ? [660, 880, 1320] : [880, 660];
    notes.forEach((f, i) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = 'triangle';
      o.frequency.value = f;
      const t = ctx.currentTime + i * 0.11;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.18, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
      o.connect(g).connect(ctx.destination);
      o.start(t);
      o.stop(t + 0.32);
    });
    setTimeout(() => ctx.close().catch(() => {}), 1200);
  } catch { /* audio is optional */ }
}
