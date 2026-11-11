import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { BudgetExceededError, __setClientForTests, costOf, createMessage, spentUsd } from './llm';

const tmpLedger = () => join(mkdtempSync(join(tmpdir(), 'mirage-llm-')), 'spend.jsonl');

function fakeClient(usage: { input_tokens: number; output_tokens: number }) {
  let calls = 0;
  const c = {
    messages: {
      create: async () => {
        calls++;
        return { id: 'msg', model: 'claude-haiku-5-5', content: [{ type: 'text', text: 'ok' }], usage, stop_reason: 'end_turn' } as any;
      },
    },
  };
  return { c, calls: () => calls };
}

const params = { model: 'claude-haiku-5-5', max_tokens: 1000, messages: [{ role: 'user' as const, content: 'hi' }] };

afterEach(() => __setClientForTests(null));

describe('llm budget guard', () => {
  it('prices Haiku 5.5 at $0.10 / $0.50 per 1M tokens', () => {
    expect(costOf('claude-haiku-5-5', { input_tokens: 100_000, output_tokens: 0 })).toBeCloseTo(0.01, 6);
    expect(costOf('claude-haiku-5-5', { input_tokens: 0, output_tokens: 1_000_000 })).toBeCloseTo(0.5, 6);
  });

  it('uses the higher Haiku rate for prompts over 100K tokens', () => {
    expect(costOf('claude-haiku-5-5', { input_tokens: 200_000, output_tokens: 0 })).toBeCloseTo(0.1, 6);
  });

  it('prices unknown models conservatively (as the most expensive tier)', () => {
    expect(costOf('some-new-model', { input_tokens: 1_000_000, output_tokens: 0 })).toBeCloseTo(10);
  });

  it('records spend in the ledger after each call', async () => {
    const ledger = tmpLedger();
    const f = fakeClient({ input_tokens: 10_000, output_tokens: 1_000 });
    __setClientForTests(f.c as any);
    await createMessage(params, { purpose: 'test', capUsd: 5, ledgerPath: ledger });
    expect(spentUsd(ledger)).toBeCloseTo((10_000 * 0.1 + 1_000 * 0.5) / 1e6, 8);
  });

  it('refuses the call and sends NOTHING once the cap would be crossed', async () => {
    const ledger = tmpLedger();
    const f = fakeClient({ input_tokens: 10_000, output_tokens: 1_000 });
    __setClientForTests(f.c as any);
    // cap smaller than the worst case of a single call
    await expect(createMessage(params, { purpose: 'test', capUsd: 0.0001, ledgerPath: ledger })).rejects.toBeInstanceOf(BudgetExceededError);
    expect(f.calls()).toBe(0);
  });

  it('stops after cumulative spend reaches the cap', async () => {
    const ledger = tmpLedger();
    const f = fakeClient({ input_tokens: 40, output_tokens: 1_000 }); // realistic for `params`: ~$0.0005 per call
    __setClientForTests(f.c as any);
    let ok = 0;
    for (let i = 0; i < 100; i++) {
      try { await createMessage(params, { purpose: 'test', capUsd: 0.005, ledgerPath: ledger }); ok++; } catch (e) { expect(e).toBeInstanceOf(BudgetExceededError); break; }
    }
    expect(ok).toBeGreaterThan(0);
    expect(ok).toBeLessThan(100);
    expect(spentUsd(ledger)).toBeLessThanOrEqual(0.005);
  });
});
