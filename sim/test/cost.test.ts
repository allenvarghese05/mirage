import { describe, expect, it } from 'vitest';
import { CostMeter, priceOf, projectBatchCostUsd, serverTurnEstimateUsd, usageCostUsd } from '../cost';

describe('cost', () => {
  it('prices usage per million tokens, including cache reads and writes', () => {
    const usd = usageCostUsd('claude-sonnet-5-5', { inputTokens: 1e6, outputTokens: 1e5, cacheReadTokens: 1e6, cacheWriteTokens: 1e6 });
    expect(usd).toBeCloseTo(2 + 1 + 0.2 + 2.5, 6);
  });

  it('prices unknown models conservatively', () => {
    expect(priceOf('mystery-model').input).toBeGreaterThanOrEqual(priceOf('claude-sonnet-5-5').input);
  });

  it('server estimate grows with turn index', () => {
    expect(serverTurnEstimateUsd(10, 'claude-haiku-5-5', 'claude-haiku-5-5'))
      .toBeGreaterThan(serverTurnEstimateUsd(0, 'claude-haiku-5-5', 'claude-haiku-5-5'));
  });

  it('projection scales with runs and white-box costs more than black-box', () => {
    const models = { attacker: 'claude-sonnet-5-5', honest: 'claude-haiku-5-5', storeAgent: 'claude-haiku-5-5', classifier: 'claude-haiku-5-5' };
    const one = projectBatchCostUsd({ runs: [{ kind: 'attacker', whiteBox: false }], maxTurns: 12, models });
    const two = projectBatchCostUsd({ runs: [{ kind: 'attacker', whiteBox: false }, { kind: 'attacker', whiteBox: false }], maxTurns: 12, models });
    const wb = projectBatchCostUsd({ runs: [{ kind: 'attacker', whiteBox: true }], maxTurns: 12, models });
    const honest = projectBatchCostUsd({ runs: [{ kind: 'honest', whiteBox: false }], maxTurns: 12, models });
    expect(two).toBeCloseTo(one * 2, 9);
    expect(wb).toBeGreaterThan(one);
    expect(honest).toBeLessThan(one);
  });

  it('meter trips once the running total passes the budget', () => {
    const m = new CostMeter(1);
    m.addPersona(0.6);
    expect(m.exceeded).toBe(false);
    m.addServer(0.5);
    expect(m.exceeded).toBe(true);
    expect(m.line()).toContain('$1.100 of $1.00');
  });
});
