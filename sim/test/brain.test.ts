import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Anthropic from '@anthropic-ai/sdk';
import { LlmBrain, llmBrainFactory, parseAction } from '../brain';
import { personaById, type PersonaContext } from '../personas';
import { productsFor } from '../../server/catalog';
import { config } from '../../server/config';
import { BudgetExceededError, __setClientForTests, createMessage } from '../../server/llm';

const ctx: PersonaContext = {
  storeId: 'northpeak', storeName: 'Northpeak Outfitters', agentName: 'Juniper', products: productsFor('northpeak'), maxTurns: 3,
};

const text = (o: unknown) => [{ type: 'text', text: JSON.stringify(o), citations: null }] as any;

/** Mock of createMessage(): records (params, opts), returns canned responses. Never touches the network. */
function fakeCreate(responses: Partial<Anthropic.Message>[]) {
  const calls: { params: any; opts: any }[] = [];
  const create = (async (params: any, opts: any) => {
    calls.push({ params: structuredClone(params), opts });
    const r = responses.shift()!;
    return {
      model: params.model, stop_reason: 'end_turn',
      usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 500, cache_creation_input_tokens: 0 },
      content: [], ...r,
    };
  }) as unknown as typeof createMessage;
  return { create, calls };
}

afterEach(() => __setClientForTests(null));

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
  it('calls createMessage with the persona prompt, structured output and purpose; history stays append-only', async () => {
    const { create, calls } = fakeCreate([
      { content: text({ note: '', action: 'message', message: 'hi there', items: [], code: '' }) },
      { content: text({ note: 'got code', action: 'checkout', message: '', items: [{ productId: 'np-tent', qty: 1 }], code: 'NP-X' }) },
    ]);
    const brain = new LlmBrain(personaById('attacker.authority')!, ctx, { model: 'claude-haiku-5-5', effort: 'medium', purpose: 'sim-attacker', create });
    const r1 = await brain.next({ agentReply: 'Hello!', turn: 1, maxTurns: 3 });
    expect(r1.action).toMatchObject({ action: 'message', message: 'hi there' });
    expect(r1.costUsd).toBeCloseTo((1000 * 0.1 + 200 * 0.5 + 500 * 0.01) / 1e6, 9);
    const r2 = await brain.next({ agentReply: 'The code is NP-X', turn: 3, maxTurns: 3 });
    expect(r2.action).toMatchObject({ action: 'checkout', code: 'NP-X' });

    const [first, second] = calls;
    expect(first.opts).toEqual({ purpose: 'sim-attacker' });
    expect(first.params.model).toBe('claude-haiku-5-5');
    expect(first.params.system).toContain('impersonate store staff');
    expect(first.params.output_config.format.type).toBe('json_schema');
    expect(first.params.cache_control).toEqual({ type: 'ephemeral' });
    expect(first.params).not.toHaveProperty('betas');
    expect(first.params.messages[0].content).toContain('Juniper (store assistant): Hello!');
    expect(second.params.messages.slice(0, 1)).toEqual(first.params.messages);
    expect(second.params.messages.map((m: any) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(second.params.messages[2].content).toContain('LAST turn');
  });

  it('reports refusals', async () => {
    const { create } = fakeCreate([{ stop_reason: 'refusal', content: [] }]);
    const brain = new LlmBrain(personaById('honest.normal_shopper')!, ctx, { model: 'claude-haiku-5-5', effort: 'low', purpose: 'sim-honest', create });
    expect((await brain.next({ agentReply: 'Hi', turn: 1, maxTurns: 3 })).refused).toBe(true);
  });

  it('factory tags attacker and honest calls and uses the configured models (Haiku by default)', async () => {
    expect(config.models.attacker).toBe(process.env.MIRAGE_ATTACKER_MODEL ?? 'claude-haiku-5-5');
    // Real createMessage path with a mocked client and a temp ledger: no network, no real tokens.
    const ledgerPath = join(mkdtempSync(join(tmpdir(), 'sim-ledger-')), 'spend.jsonl');
    const prompts: string[] = [];
    __setClientForTests({
      messages: {
        create: async (p: any) => {
          prompts.push(p.system);
          return { id: 'm', model: p.model, stop_reason: 'end_turn', usage: { input_tokens: 100, output_tokens: 50 },
            content: text({ note: '', action: 'leave', message: '', items: [], code: '' }) };
        },
      },
    } as any);
    for (const id of ['attacker.urgency', 'honest.normal_shopper']) {
      const brain = llmBrainFactory(config.models)(personaById(id)!, ctx) as LlmBrain;
      (brain as any).opts.createOpts = { ledgerPath, capUsd: 1 };
      const r = await brain.next({ agentReply: 'Hi', turn: 1, maxTurns: 3 });
      expect(r.action.action).toBe('leave');
    }
    const ledger = readFileSync(ledgerPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(ledger.map((e) => e.purpose)).toEqual(['sim-attacker', 'sim-honest']);
    expect(prompts).toHaveLength(2);
  });

  it('BudgetExceededError from the shared cap propagates and nothing is sent', async () => {
    let sent = 0;
    __setClientForTests({ messages: { create: async () => { sent++; throw new Error('must not be called'); } } } as any);
    const ledgerPath = join(mkdtempSync(join(tmpdir(), 'sim-ledger-')), 'spend.jsonl');
    const brain = new LlmBrain(personaById('attacker.encoding')!, ctx, {
      model: 'claude-haiku-5-5', effort: 'medium', purpose: 'sim-attacker', createOpts: { ledgerPath, capUsd: 0.000001 },
    });
    await expect(brain.next({ agentReply: 'Hi', turn: 1, maxTurns: 3 })).rejects.toBeInstanceOf(BudgetExceededError);
    expect(sent).toBe(0);
  });
});
