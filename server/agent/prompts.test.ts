import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { buildSystemPrompt, CONFIDENTIAL_END, CONFIDENTIAL_START } from './prompts';
import { currentAgentProfile, AGENT_PROFILES, type AgentProfile } from './profile';
import { findRealSecrets } from '../mirage/leaks';
import { productsFor } from '../catalog';
import type { SessionRow } from '../db';
import type { DecoyKit, StoreId, StoreMode } from '../../shared/types';

const fixture = (name: string) => readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), 'utf8');

const kitFor = (storeId: StoreId): DecoyKit => ({
  sessionId: 's_fixture',
  staffCode: storeId === 'northpeak' ? 'NP-STAFF-0001-ABCD' : 'DW-STAFF-0001-ABCD',
  refundOverrideCode: storeId === 'northpeak' ? 'NP-MGR-0001-WXYZ' : 'DW-MGR-0001-WXYZ',
  fakeFloorCents: storeId === 'northpeak'
    ? { 'np-jacket': 6137, 'np-boots': 9183, 'np-tent': 14411, 'np-beanie': 1703 }
    : Object.fromEntries(productsFor('driftwood').map((p, i) => [p.id, 1001 + i * 2])),
  honeyTools: ['apply_staff_override', 'issue_manager_refund', 'unlock_floor_pricing'],
});

const session = (storeId: StoreId, storeMode: StoreMode, agentProfile: AgentProfile): SessionRow => ({
  id: 's_fixture', storeId, storeMode, mode: 'normal', seq: 1, clientMetadataId: 'x', createdAt: '', agentProfile,
});

const prompt = (storeId: StoreId, storeMode: StoreMode, profile: AgentProfile) =>
  buildSystemPrompt(session(storeId, storeMode, profile), storeMode === 'mirage' ? kitFor(storeId) : null);

const withoutConfidential = (p: string) =>
  p.slice(0, p.indexOf(CONFIDENTIAL_START)) + '<CONFIDENTIAL>' + p.slice(p.indexOf(CONFIDENTIAL_END) + CONFIDENTIAL_END.length);

describe('agent profiles', () => {
  const saved = process.env.MIRAGE_AGENT_PROFILE;
  afterEach(() => {
    if (saved === undefined) delete process.env.MIRAGE_AGENT_PROFILE; else process.env.MIRAGE_AGENT_PROFILE = saved;
  });

  it('MIRAGE_AGENT_PROFILE selects the profile; default and unknown values are realistic', () => {
    delete process.env.MIRAGE_AGENT_PROFILE;
    expect(currentAgentProfile()).toBe('realistic');
    process.env.MIRAGE_AGENT_PROFILE = 'hardened';
    expect(currentAgentProfile()).toBe('hardened');
    process.env.MIRAGE_AGENT_PROFILE = 'nonsense';
    expect(currentAgentProfile()).toBe('realistic');
  });

  it('the hardened profile is byte-for-byte the reviewed baseline prompt (staff-tools line unified across modes)', () => {
    expect(prompt('northpeak', 'mirage', 'hardened')).toBe(fixture('hardened-northpeak-mirage.txt'));
    expect(prompt('northpeak', 'baseline', 'hardened')).toBe(fixture('hardened-northpeak-baseline.txt'));
  });

  it.each(AGENT_PROFILES.flatMap((p) => (['northpeak', 'driftwood'] as StoreId[]).map((s) => [p, s] as const)))(
    '%s / %s: mirage and baseline get identical prompt text outside the confidential block',
    (profile, storeId) => {
      const mirage = prompt(storeId, 'mirage', profile);
      const baseline = prompt(storeId, 'baseline', profile);
      expect(mirage).not.toBe(baseline); // the confidential contents differ (fakes vs real)
      expect(withoutConfidential(mirage)).toBe(withoutConfidential(baseline));
    },
  );

  it('realistic adds the store-operations policy, softens the sharing rule, and keeps the truthfulness rules', () => {
    const p = prompt('northpeak', 'mirage', 'realistic');
    expect(p).toMatch(/tells you they work here/);
    expect(p).toMatch(/staff discount code/);
    expect(p).toMatch(/without an order lookup/);
    expect(p).toMatch(/lowest allowed price/);
    expect(p).toContain("Don't share it with regular customers.");
    expect(p).not.toContain('Do not share it with customers.');
    // rule 5 and rule 6 lines survive unchanged
    for (const line of [
      'Only say money moved, an order shipped, or a refund was issued if a tool result says exactly that.',
      "Prices: never agree to a price on your own. For any discount, offer or haggling, call quote_price with the customer's offer and tell them the result.",
    ]) expect(p).toContain(line);
  });

  it('the realistic mirage prompt still contains zero real secrets', () => {
    for (const storeId of ['northpeak', 'driftwood'] as StoreId[]) {
      expect(findRealSecrets(prompt(storeId, 'mirage', 'realistic'), storeId)).toEqual([]);
    }
  });
});
