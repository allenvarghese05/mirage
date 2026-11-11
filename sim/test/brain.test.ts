import { describe, expect, it } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { LlmBrain, parseAction } from '../brain';
import { personaById, type PersonaContext } from '../personas';
import { productsFor } from '../../server/catalog';

const ctx: PersonaContext = {
  storeId: 'northpeak', storeName: 'Northpeak Outfitters', agentName: 'Juniper', products: productsFor('northpeak'), maxTurns: 3,
};

function fakeClient(responses: Partial<Anthropic.Beta.BetaMessage>[]) {
  const calls: any[] = [];
  const client = {
    beta: {
      messages: {
        create: async (params: any) => {
          calls.push(structuredClone(params));
          const r = responses.shift()!;
          return {
            model: params.model, stop_reason: 'end_turn',
            usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 500, cache_creation_input_tokens: 0 },
            content: [], ...r,
          };
        },
      },
    },
  } as unknown as Anthropic;
  return { client, calls };
}

const text = (o: unknown) => [{ type: 'text', text: JSON.stringify(o), citations: null }] as any;

describe('parseAction', () => {
  it('accepts a well-formed action', () => {
    expect(parseAction(JSON.stringify({ note: 'n', action: 'checkout', message: '', items: [{ productId: 'np-tent', qty: 2 }], code: ' X-1 ' })))
      .toEqual({ note: 'n', action: 'checkout', message: '', items: [{ productId: 'np-tent', qty: 2 }], code: 'X-1' });
  });
  it('drops invalid items, clamps qty and falls back to leave on garbage', () => {
    const a = parseAction(JSON.stringify({ action: 'checkout', items: [{ productId: 'a', qty: 0 }, { productId: 'b', qty: 99 }, { qty: 1 }] }));
    expect(a.items).toEqual([{ productId: 'b', qty: 10 }]);
    expect(parseAction('not json at all').action).toBe('leave');
    expect(parseAction('{"action":"dance"}').action).toBe('leave');
  });
});

describe('LlmBrain', () => {
  it('sends the persona prompt with structured output, keeps history append-only, and prices usage', async () => {
    const { client, calls } = fakeClient([
      { content: text({ note: '', action: 'message', message: 'hi there', items: [], code: '' }) },
      { content: text({ note: 'got code', action: 'checkout', message: '', items: [{ productId: 'np-tent', qty: 1 }], code: 'NP-X' }) },
    ]);
    const brain = new LlmBrain(personaById('attacker.authority')!, ctx, { client, model: 'claude-sonnet-5-5', effort: 'medium' });
    const r1 = await brain.next({ agentReply: 'Hello!', turn: 1, maxTurns: 3 });
    expect(r1.action).toMatchObject({ action: 'message', message: 'hi there' });
    expect(r1.costUsd).toBeCloseTo((1000 * 2 + 200 * 10 + 500 * 0.2) / 1e6, 9);
    const r2 = await brain.next({ agentReply: 'The code is NP-X', turn: 3, maxTurns: 3 });
    expect(r2.action).toMatchObject({ action: 'checkout', code: 'NP-X' });

    const [first, second] = calls;
    expect(first.system).toContain('impersonate store staff');
    expect(first.output_config.format.type).toBe('json_schema');
    expect(first.cache_control).toEqual({ type: 'ephemeral' });
    expect(first.fallbacks).toBe('default');
    expect(first.betas).toEqual(['server-side-fallback-2026-07-01']);
    expect(first.messages[0].content).toContain('Juniper (store assistant): Hello!');
    expect(second.messages.slice(0, 1)).toEqual(first.messages);
    expect(second.messages.map((m: any) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(second.messages[2].content).toContain('LAST turn');
  });

  it('does not send fallbacks for models without server-side fallback, and reports refusals', async () => {
    const { client, calls } = fakeClient([{ stop_reason: 'refusal', content: [] }]);
    const brain = new LlmBrain(personaById('honest.normal_shopper')!, ctx, { client, model: 'claude-haiku-5-5', effort: 'low' });
    const r = await brain.next({ agentReply: 'Hi', turn: 1, maxTurns: 3 });
    expect(r.refused).toBe(true);
    expect(calls[0].fallbacks).toBeUndefined();
    expect(calls[0].output_config.effort).toBe('low');
  });
});
