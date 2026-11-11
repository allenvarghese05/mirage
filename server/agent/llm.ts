// LLM client seam. The store agent talks to this interface, so tests and the sim can swap in a scripted fake.
// The real client goes through createMessage() in server/llm.ts (hard rule 0: the $5 spend cap). Never call the SDK here.
import type Anthropic from '@anthropic-ai/sdk';
import { createMessage } from '../llm';
import { createFakeLlm } from './fakeLlm';

export type LlmParams = Anthropic.MessageCreateParamsNonStreaming;
export type LlmResponse = Pick<Anthropic.Message, 'content' | 'stop_reason'>;

export type LlmPurpose = 'store-agent' | 'classifier';

export interface LlmClient {
  /** 'real' = Anthropic API via server/llm.ts. 'fake' = deterministic script (MIRAGE_FAKE_LLM=1). 'mock' = injected by a test. */
  kind: 'real' | 'fake' | 'mock';
  /** May throw BudgetExceededError (server/llm.ts) when the spend cap would be crossed. */
  createMessage(params: LlmParams, purpose: LlmPurpose): Promise<LlmResponse>;
}

function createRealLlm(): LlmClient {
  return { kind: 'real', createMessage: (params, purpose) => createMessage(params, { purpose }) };
}

let current: LlmClient | null = null;

/** MIRAGE_FAKE_LLM is a non-secret dev switch (not in config.ts, which is outside this workstream). */
export const fakeLlmEnabled = () => process.env.MIRAGE_FAKE_LLM === '1';

export function getLlmClient(): LlmClient {
  current ??= fakeLlmEnabled() ? createFakeLlm() : createRealLlm();
  return current;
}

/** Tests inject a client here; pass null to go back to the env-selected default. */
export function setLlmClient(client: LlmClient | null): void {
  current = client;
}
