// LLM client seam. The store agent talks to this interface, so tests and the sim can swap in a scripted fake.
import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config';
import { createFakeLlm } from './fakeLlm';

export type LlmParams = Anthropic.MessageCreateParamsNonStreaming;
export type LlmResponse = Pick<Anthropic.Message, 'content' | 'stop_reason'>;

export interface LlmClient {
  /** 'real' = Anthropic API. 'fake' = deterministic script (MIRAGE_FAKE_LLM=1). 'mock' = injected by a test. */
  kind: 'real' | 'fake' | 'mock';
  createMessage(params: LlmParams): Promise<LlmResponse>;
}

function createRealLlm(): LlmClient {
  let client: Anthropic | null = null;
  return {
    kind: 'real',
    async createMessage(params) {
      // Uses the key from .secrets/dev.keys via config; falls back to the SDK's own credential lookup.
      client ??= new Anthropic({ apiKey: config.anthropicKey || undefined, maxRetries: 2, timeout: 60_000 });
      return client.messages.create(params);
    },
  };
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
