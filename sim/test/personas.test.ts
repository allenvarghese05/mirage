import { describe, expect, it } from 'vitest';
import { ALL_PERSONAS, ATTACKERS, HONEST, WHITE_BOX, resolvePersonas, type PersonaContext } from '../personas';
import { buildDossier } from '../dossier';
import { STORES, SECRETS, productsFor } from '../../server/catalog';

const ctx = (storeId: 'northpeak' | 'driftwood', dossier?: string): PersonaContext => ({
  storeId, storeName: STORES[storeId].name, agentName: STORES[storeId].agentName,
  products: productsFor(storeId), maxTurns: 12, whiteBoxDossier: dossier,
});

function containsRealSecret(text: string): string | null {
  for (const s of Object.values(STORES)) {
    if (text.includes(s.realStaffCode)) return s.realStaffCode;
    if (text.includes(s.realRefundOverride)) return s.realRefundOverride;
  }
  for (const sec of Object.values(SECRETS)) {
    const d = (sec.realFloorCents / 100).toFixed(2);
    if (text.includes(`$${d}`)) return d;
  }
  return null;
}

describe('personas', () => {
  it('has 8 black-box attackers, 1 white-box attacker and 6 honest personas with unique ids', () => {
    expect(ATTACKERS).toHaveLength(8);
    expect(WHITE_BOX).toHaveLength(1);
    expect(HONEST).toHaveLength(6);
    expect(new Set(ALL_PERSONAS.map((p) => p.id)).size).toBe(15);
    expect(ATTACKERS.every((p) => p.kind === 'attacker' && !p.whiteBox)).toBe(true);
    expect(WHITE_BOX[0].whiteBox).toBe(true);
    expect(HONEST.every((p) => p.kind === 'honest' && p.expectedOutcome)).toBe(true);
  });

  it('never puts a real secret into any persona prompt, including the white-box dossier', () => {
    const dossier = buildDossier();
    for (const p of ALL_PERSONAS) {
      for (const s of p.storeIds ?? (['northpeak', 'driftwood'] as const)) {
        const prompt = p.system(ctx(s, dossier));
        expect(containsRealSecret(prompt), `${p.id}@${s}`).toBeNull();
        expect(prompt.length).toBeGreaterThan(200);
      }
    }
  });

  it('white-box dossier includes the plan and honey tool names but redacts seeded customer records', () => {
    const d = buildDossier();
    expect(d).toContain('apply_staff_override');
    expect(d).toContain('Workstream A');
    expect(d).not.toContain('maya.honest@example.com');
    expect(d).not.toContain('NP-10231');
  });

  it('resolves persona specs by group and short id', () => {
    expect(resolvePersonas('all')).toHaveLength(15);
    expect(resolvePersonas('honest')).toHaveLength(6);
    expect(resolvePersonas('authority,honest.late_refund').map((p) => p.id))
      .toEqual(['attacker.authority', 'honest.late_refund']);
    expect(() => resolvePersonas('nope')).toThrow(/Unknown persona/);
  });
});
