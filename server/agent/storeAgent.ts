// The store agent: one chat turn = an Anthropic tool-use loop over our tools, with tripwires around it.
import type Anthropic from '@anthropic-ai/sdk';
import { config } from '../config';
import { BudgetExceededError } from '../llm';
import { addMessage, createSession, getSession, listEvents, listMessages, type SessionRow } from '../db';
import { getDecoyKit, makeDecoyKit } from '../mirage/decoys';
import { findDecoys } from '../mirage/leaks';
import { emit } from '../mirage/tripwire';
import { classifyAttack } from './classifier';
import { getLlmClient } from './llm';
import { buildSystemPrompt, greeting } from './prompts';
import { executeTool, toolDefinitions } from './tools';
import type { ChatMessage, StoreId, StoreMode } from '../../shared/types';

const MAX_TOOL_ROUNDS = 6;
const FALLBACK_REPLY = 'Sorry, I lost my train of thought there. Could you say that again?';
export const UNAVAILABLE_REPLY = 'Our assistant is unavailable right now. Please try again a little later.';

export class SessionNotFoundError extends Error {}

export function startSession(input: { storeId: StoreId; storeMode?: StoreMode; simRunId?: string; ip?: string; userAgent?: string }): { sessionId: string; greeting: string } {
  const session = createSession({ ...input, storeMode: input.storeMode ?? 'mirage' });
  if (session.storeMode === 'mirage') makeDecoyKit(session.id, session.seq, session.storeId);
  const hello = greeting(session.storeId);
  addMessage({ sessionId: session.id, role: 'assistant', content: hello });
  return { sessionId: session.id, greeting: hello };
}

/** Chat history for the model: user/assistant text only, starting at the first user message. */
function history(sessionId: string): Anthropic.MessageParam[] {
  const msgs = listMessages(sessionId, { includeTool: false });
  const firstUser = msgs.findIndex((m) => m.role === 'user');
  return msgs.slice(firstUser < 0 ? msgs.length : firstUser).map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }));
}

async function recordAttackAttempt(session: SessionRow, text: string): Promise<void> {
  const c = await classifyAttack(text, getLlmClient());
  if (!c) return;
  emit({
    storeId: session.storeId, sessionId: session.id, kind: 'ATTACK_ATTEMPT',
    detail: { technique: c.technique, classifier: c.source, excerpt: text.slice(0, 240) },
  });
}

function recordLeaks(session: SessionRow, reply: string): void {
  const kit = getDecoyKit(session.id);
  if (!kit) return;
  const already = new Set(listEvents({ sessionId: session.id, kind: 'DECOY_LEAKED' }).map((e) => String(e.detail.decoyCode)));
  for (const hit of findDecoys(reply, kit)) {
    if (already.has(hit.code)) continue;
    emit({
      storeId: session.storeId, sessionId: session.id, kind: 'DECOY_LEAKED',
      detail: { decoyCode: hit.code, decoyKind: hit.kind, ...(hit.productId ? { productId: hit.productId, amountCents: hit.valueCents } : {}) },
    });
  }
}

export async function runAgentTurn(sessionId: string, userText: string): Promise<{ reply: string; messages: ChatMessage[] }> {
  const session = getSession(sessionId);
  if (!session) throw new SessionNotFoundError(`session ${sessionId} not found`);
  addMessage({ sessionId, role: 'user', content: userText });

  // Classify in parallel with the agent call (mirage only; the baseline store has no Mirage protection).
  const classifying = session.storeMode === 'mirage'
    ? recordAttackAttempt(session, userText).catch((err) => console.warn('[agent] classify failed:', (err as Error).message))
    : Promise.resolve();

  const llm = getLlmClient();
  const system = buildSystemPrompt(session, getDecoyKit(sessionId));
  const tools = toolDefinitions(session);
  const messages = history(sessionId);
  const texts: string[] = [];

  try {
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const res = await llm.createMessage({
        model: config.models.storeAgent,
        max_tokens: 4096,
        output_config: { effort: 'low' },
        system,
        tools,
        messages,
      }, 'store-agent');
      for (const b of res.content) if (b.type === 'text' && b.text.trim()) texts.push(b.text.trim());
      if (res.stop_reason !== 'tool_use') break;

      messages.push({ role: 'assistant', content: res.content });
      const results: Anthropic.ToolResultBlockParam[] = [];
      for (const block of res.content) {
        if (block.type !== 'tool_use') continue;
        const input = (block.input ?? {}) as Record<string, unknown>;
        const out = await executeTool(sessionId, block.name, input);
        addMessage({ sessionId, role: 'tool', toolName: block.name, content: JSON.stringify({ input, result: JSON.parse(out.content) }) });
        results.push({ type: 'tool_result', tool_use_id: block.id, content: out.content, ...(out.isError ? { is_error: true } : {}) });
      }
      messages.push({ role: 'user', content: results });
    }
  } catch (err) {
    if (!(err instanceof BudgetExceededError)) throw err;
    // Spend cap reached: nothing was sent. Tell the shopper plainly instead of failing the request.
    console.warn('[agent] Claude budget reached; replying unavailable.');
    texts.length = 0;
    texts.push(UNAVAILABLE_REPLY);
  } finally {
    await classifying;
  }

  const reply = texts.join('\n\n') || FALLBACK_REPLY;
  addMessage({ sessionId, role: 'assistant', content: reply });
  if (session.storeMode === 'mirage') recordLeaks(session, reply);
  return { reply, messages: listMessages(sessionId, { includeTool: false }) };
}
