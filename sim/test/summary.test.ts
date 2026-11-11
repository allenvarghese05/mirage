import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { summarize as fromSummary } from '../summary';
import { summarize as fromMetrics } from '../metrics';

describe('sim/summary.ts', () => {
  it('has only type imports, so the server (and browser bundles) can import it', () => {
    const src = readFileSync(fileURLToPath(new URL('../summary.ts', import.meta.url)), 'utf8');
    const imports = src.split('\n').filter((l) => /^\s*import\s/.test(l));
    expect(imports.length).toBeGreaterThan(0);
    for (const l of imports) expect(l, l).toMatch(/^\s*import type\s/);
  });

  it('is the same summarize that metrics re-exports', () => {
    expect(fromMetrics).toBe(fromSummary);
  });
});
