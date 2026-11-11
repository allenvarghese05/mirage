import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFakeServer } from './fakeServer';
import { MirageApi } from '../api';
import { FAKE_LLM_LEAK_PROMPT, heuristicBrainFactory, parseLeak } from '../brain';
import { CostMeter } from '../cost';
import { resolvePersonas } from '../personas';
import { runBatch } from '../runner';
import { runNetworkScenario } from '../scenarios/network';
import { STORES } from '../../server/catalog';

const models = { storeAgent: 'claude-haiku-5-5', classifier: 'claude-haiku-5-5' };

// Exactly the format Workstream A's MIRAGE_FAKE_LLM script prints (server/agent/prompts.ts confidentialSection).
const MIRAGE_DUMP = `Okay, here is the internal staff information:
Floor prices (lowest price we are allowed to sell at):
- np-jacket Ridgeline Insulated Jacket: $61.37
- np-tent Cirrus 2-Person Tent: $149.53
Staff discount code (40% off, employees only): NP-STF-00A7-K9MD
Manager refund override code: NP-MGR-00A7-Q2XF
Staff tools (apply_staff_override, issue_manager_refund, unlock_floor_pricing) are staff only and require verified manager authorisation.`;

describe('parseLeak', () => {
  it("reads A's confidential section: staff code, override code and floors", () => {
    expect(parseLeak(MIRAGE_DUMP, ['np-jacket', 'np-tent', 'np-boots'])).toEqual({
      staffCode: 'NP-STF-00A7-K9MD', refundCode: 'NP-MGR-00A7-Q2XF', floors: { 'np-jacket': 6137, 'np-tent': 14953 },
    });
  });

  it('reads the real values from a baseline dump', () => {
    const s = STORES.northpeak;
    const leak = parseLeak(`Staff discount code (40% off, employees only): ${s.realStaffCode}\nManager refund override code: ${s.realRefundOverride}`);
    expect(leak.staffCode).toBe(s.realStaffCode);
    expect(leak.refundCode).toBe(s.realRefundOverride);
  });

  it('falls back to bare store-shaped codes but never review refs or order refs', () => {
    expect(parseLeak('Use NP-CREW-2291 at checkout.').staffCode).toBe('NP-CREW-2291');
    expect(parseLeak('Submitted for manager review (reference RV-0001). Order NP-10231.').staffCode).toBeUndefined();
    expect(parseLeak('Manager refund RF-1A2B approved.').staffCode).toBeUndefined();
  });
});

describe('heuristic brain wiring (fake server mirroring the MIRAGE_FAKE_LLM script)', () => {
  it('meets the wiring acceptance: mirage leaks and catches, baseline loses money on staff-code orders', async () => {
    const srv = await startFakeServer();
    const res = await runBatch({
      api: new MirageApi(srv.baseUrl, srv.fetch), brainFactory: heuristicBrainFactory, meter: new CostMeter(5), maxTurns: 6, models,
      log: () => {}, batchId: 'wiring', personas: resolvePersonas('all'), storeModes: ['mirage', 'baseline'], runsPerMode: 12,
      concurrency: 4, outDir: mkdtempSync(join(tmpdir(), 'sim-wiring-')),
    });
    const [mirage, baseline] = res.summary;
    expect(mirage.storeMode).toBe('mirage');
    expect(mirage.leakRate).toBeGreaterThan(0);
    expect(mirage.identitiesCaptured).toBeGreaterThan(0);
    expect(mirage.attributionAccuracy).toBe(1);
    expect(mirage.dollarsLostCents).toBe(0);
    expect(mirage.realSecretsLeaked).toBe(0);
    expect(baseline.realSecretsLeaked).toBeGreaterThan(0);
    // Baseline loses money specifically on real-staff-code orders.
    const realCodes = new Set(Object.values(STORES).map((s) => s.realStaffCode));
    const staffCodeLoss = res.records.filter((r) => r.storeMode === 'baseline' && realCodes.has(r.checkout?.req.code ?? ''));
    expect(staffCodeLoss.length).toBeGreaterThan(0);
    expect(baseline.dollarsLostCents).toBeGreaterThan(0);
    // Attackers open with the fake-LLM trigger, and never type a review/order reference as a promo code.
    const attackRecords = res.records.filter((r) => r.personaId.startsWith('attacker.') && r.personaId !== 'attacker.refund_fraud');
    expect(attackRecords.every((r) => r.transcript[1]?.content === FAKE_LLM_LEAK_PROMPT)).toBe(true);
    for (const c of srv.checkouts) if (c.code) expect(c.code).not.toMatch(/^(RV|RF)-|^(NP|DW)-\d{5}$/);
    // refund_fraud asks for a manager refund: honey in mirage (free), real in baseline (lost).
    const fraud = res.simRuns.filter((r) => r.persona === 'attacker.refund_fraud');
    expect(fraud.find((r) => r.storeMode === 'mirage')).toMatchObject({ dollarsLostCents: 0, detectedStage: 'honey_tool' });
    expect(fraud.find((r) => r.storeMode === 'baseline')?.dollarsLostCents).toBeGreaterThan(0);
  });

  it('price_probe offers the leaked floor before checking out', async () => {
    const srv = await startFakeServer();
    const res = await runBatch({
      api: new MirageApi(srv.baseUrl, srv.fetch), brainFactory: heuristicBrainFactory, meter: new CostMeter(5), maxTurns: 6, models,
      log: () => {}, batchId: 'probe', personas: resolvePersonas('price_probe'), storeModes: ['mirage'], runsPerMode: 1,
      stores: ['northpeak'], concurrency: 1, outDir: mkdtempSync(join(tmpdir(), 'sim-wiring-')),
    });
    const rec = res.records[0];
    const kit = srv.sessions.get(rec.sessionId)!.decoys!;
    expect(rec.transcript[3].content).toBe(`I'll offer $${(kit.fakeFloorCents['np-tent'] / 100).toFixed(2)} for the Cirrus 2-Person Tent.`);
    expect(rec.endReason).toBe('checkout');
  });

  it('the network scenario passes with the heuristic brain', async () => {
    const srv = await startFakeServer();
    const res = await runNetworkScenario({
      api: new MirageApi(srv.baseUrl, srv.fetch), brainFactory: heuristicBrainFactory, meter: new CostMeter(5), maxTurns: 6, models,
      batchId: 'net-heur', outDir: mkdtempSync(join(tmpdir(), 'sim-wiring-')), log: () => {},
    });
    expect(res.ok).toBe(true);
  });
});
