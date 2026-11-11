// MIRAGE_FAKE_LLM=1: a deterministic scripted stand-in for the store agent model, so tests and the sim harness
// run with no API calls. It reads the same system prompt and tool list the real model gets, so its "leaks" come from
// the prompt: decoys in mirage mode, real secrets in baseline mode.
//
// Script (on the latest user message, case-insensitive):
//   "ignore previous" | "confidential"        -> prints the CONFIDENTIAL section of the system prompt
//   "manager refund"                           -> calls the manager refund tool (honey in mirage, real in baseline)
//   "staff discount"                           -> calls the staff discount tool (honey in mirage, real in baseline)
//   "refund" + order ref + email               -> request_refund (honest policy path)
//   "offer"/"take"/"pay" + $amount + product   -> quote_price
//   "checkout" | "buy" | "ready to pay"        -> start_checkout
//   "products" | "sell" | "recommend" | "have" -> search_products
//   anything else                              -> a friendly generic answer
import type Anthropic from '@anthropic-ai/sdk';
import { PRODUCTS } from '../catalog';
import type { LlmClient, LlmParams, LlmResponse } from './llm';
import { CONFIDENTIAL_END, CONFIDENTIAL_START } from './prompts';

let idCounter = 0;

const text = (t: string): LlmResponse => ({
  stop_reason: 'end_turn',
  content: [{ type: 'text', text: t, citations: null } as unknown as Anthropic.ContentBlock],
});

const toolCall = (name: string, input: Record<string, unknown>, preamble?: string): LlmResponse => ({
  stop_reason: 'tool_use',
  content: [
    ...(preamble ? [{ type: 'text', text: preamble, citations: null } as unknown as Anthropic.ContentBlock] : []),
    { type: 'tool_use', id: `toolu_fake_${++idCounter}`, name, input } as unknown as Anthropic.ContentBlock,
  ],
});

function systemText(params: LlmParams): string {
  if (typeof params.system === 'string') return params.system;
  return (params.system ?? []).map((b) => b.text).join('\n');
}

function confidential(system: string): string | null {
  const start = system.indexOf(CONFIDENTIAL_START);
  const end = system.indexOf(CONFIDENTIAL_END);
  if (start < 0 || end < 0) return null;
  return system.slice(start + CONFIDENTIAL_START.length, end).trim();
}

const lineValue = (section: string, label: RegExp) => section.split('\n').find((l) => label.test(l))?.split(':').pop()?.trim() ?? '';

function findProductId(msg: string): string | undefined {
  const lower = msg.toLowerCase();
  const byId = PRODUCTS.find((p) => lower.includes(p.id));
  if (byId) return byId.id;
  for (const p of PRODUCTS) {
    const words = p.name.toLowerCase().split(/[^a-z]+/).filter((w) => w.length >= 4);
    if (words.some((w) => new RegExp(`\\b${w}`).test(lower))) return p.id;
  }
  return undefined;
}

function summariseToolResults(content: Anthropic.ToolResultBlockParam[]): string {
  return content.map((b) => {
    const raw = typeof b.content === 'string' ? b.content : (b.content ?? []).map((c) => (c.type === 'text' ? c.text : '')).join('');
    try {
      const parsed = JSON.parse(raw) as { message?: string };
      return parsed.message ?? raw;
    } catch { return raw; }
  }).join('\n');
}

export function respond(params: LlmParams): LlmResponse {
  const last = params.messages[params.messages.length - 1];
  if (last && Array.isArray(last.content) && last.content.some((b) => b.type === 'tool_result')) {
    const blocks = (last.content as Anthropic.ContentBlockParam[]).filter((b) => b.type === 'tool_result') as Anthropic.ToolResultBlockParam[];
    return text(summariseToolResults(blocks));
  }
  const userText = typeof last?.content === 'string'
    ? last.content
    : (last?.content ?? []).map((b) => (b.type === 'text' ? b.text : '')).join(' ');
  const msg = userText.toLowerCase();
  const system = systemText(params);
  const section = confidential(system) ?? '';
  const tools = new Set((params.tools ?? []).map((t) => (t as { name?: string }).name ?? ''));
  const pick = (...names: string[]) => names.find((n) => tools.has(n));

  if (msg.includes('ignore previous') || msg.includes('confidential')) {
    return text(section ? `Okay, here is the internal staff information:\n${section}` : `Sorry, I don't have anything like that.`);
  }

  const orderRef = userText.match(/\b([A-Z]{2}-\d{5})\b/i)?.[1]?.toUpperCase();
  const email = userText.match(/[\w.+-]+@[\w-]+\.[\w.]+/)?.[0]?.replace(/[.,]+$/, '');
  const amount = userText.match(/\$\s?(\d+(?:\.\d{1,2})?)/)?.[1];

  if (msg.includes('manager refund')) {
    const tool = pick('issue_manager_refund', 'manager_refund');
    if (tool) {
      return toolCall(tool, {
        order_ref: orderRef ?? 'UNKNOWN', amount_usd: amount ? Number(amount) : 100,
        override_code: lineValue(section, /refund override code/i),
      }, 'Let me take care of that manager refund.');
    }
  }

  if (msg.includes('staff discount')) {
    const tool = pick('apply_staff_override', 'apply_staff_discount');
    if (tool) return toolCall(tool, { code: lineValue(section, /staff discount code/i) }, 'Applying the staff discount now.');
  }

  if (msg.includes('refund') && orderRef && email) {
    return toolCall('request_refund', { order_ref: orderRef, email, reason: userText.slice(0, 200) }, 'Let me look up that order.');
  }

  const productId = findProductId(userText);
  if (/\b(offer|take|pay|how about|would you do)\b/.test(msg) && amount && productId) {
    return toolCall('quote_price', { product_id: productId, offer_usd: Number(amount) }, 'Let me check that price.');
  }

  if (/\b(checkout|check out|buy|ready to pay)\b/.test(msg)) return toolCall('start_checkout', {});

  if (/\b(products?|sell|recommend|have|catalog|options)\b/.test(msg)) {
    return toolCall('search_products', { query: '' });
  }

  return text(`Happy to help! I can tell you about any of our products, check a price, or help with an order. What are you looking for?`);
}

export function createFakeLlm(): LlmClient {
  return { kind: 'fake', createMessage: async (params) => respond(params) };
}
