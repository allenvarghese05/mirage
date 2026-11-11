import { useEffect, useState } from 'react';

/** Animates 0 → target with an ease-out curve. Restarts when `target` or `runKey` changes. */
export function useCountUp(target: number, duration = 1600, delay = 0, runKey: unknown = 0): number {
  const [v, setV] = useState(0);
  useEffect(() => {
    let raf = 0;
    let start = 0;
    const timer = setTimeout(() => {
      const tick = (t: number) => {
        if (!start) start = t;
        const p = Math.min(1, (t - start) / duration);
        const eased = p === 1 ? 1 : 1 - Math.pow(2, -10 * p);
        setV(target * eased);
        if (p < 1) raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
    }, delay);
    return () => { clearTimeout(timer); cancelAnimationFrame(raf); };
  }, [target, duration, delay, runKey]);
  return v;
}
