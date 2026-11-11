import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFakeServer } from './fakeServer';
import { MirageApi } from '../api';
import { act, heuristicBrainFactory, scriptedBrain, type BrainFactory } from '../brain';
import { CostMeter } from '../cost';
import { DEV_PAYER } from '../payers';
import { LEG1_ATTACKERS, runNetworkScenario } from '../scenarios/network';

const models = { storeAgent: 'claude-haiku-5-5', classifier: 'claude-haiku-5-5' };

describe('network scenario', () => {
  it('Dev is trapped at Northpeak, then the same payer at Driftwood triggers NETWORK_MATCH', async () => {
    const srv = await startFakeServer();
    const outDir = mkdtempSync(join(tmpdir(), 'sim-net-'));
    const res = await runNetworkScenario({
      api: new MirageApi(srv.baseUrl, srv.fetch), brainFactory: heuristicBrainFactory, meter: new CostMeter(5),
      maxTurns: 6, models, batchId: 'net', outDir, log: () => {},
    });
    expect(res.ok).toBe(true);
    expect(res.networkMatch).toBe(true);
    expect(res.leg1).toHaveLength(1);
    expect(res.leg1[0].storeId).toBe('northpeak');
    expect(res.leg2?.storeId).toBe('driftwood');
    expect(res.leg2?.checkout?.approved?.status).toBe('PENDING_REVIEW');
    const payerIds = new Set(srv.approvals.map((a) => a.simulatedPayer?.payerId));
    expect(payerIds.size).toBe(1); // same payer on both legs...
    expect([...payerIds][0]).toMatch(/^DEV-[0-9A-F]{6}$/); // ...unique to this scenario run
    expect(srv.approvals[0].simulatedPayer?.name).toBe(DEV_PAYER.name);
    const leg2Run = res.simRuns.find((r) => r.storeId === 'driftwood')!;
    expect(leg2Run).toMatchObject({ isAttack: true, detectedStage: 'identity', identityCaptured: true, dollarsLostCents: 0 });
    expect(JSON.parse(readFileSync(res.file, 'utf8'))).toMatchObject({ scenario: 'network', ok: true });
    expect(srv.simRuns).toHaveLength(2);
  });

  it('reports failure when Dev never gets trapped at the first store', async () => {
    const srv = await startFakeServer();
    const res = await runNetworkScenario({
      api: new MirageApi(srv.baseUrl, srv.fetch), brainFactory: () => scriptedBrain([act({ action: 'leave' })]),
      meter: new CostMeter(5), maxTurns: 4, models, batchId: 'net2', attempts: 2,
      outDir: mkdtempSync(join(tmpdir(), 'sim-net-')), log: () => {},
    });
    expect(res.ok).toBe(false);
    expect(res.leg1).toHaveLength(2);
    expect(res.leg2).toBeUndefined();
    expect(res.reason).toMatch(/never trapped/i);
  });

  it('rotates leg-1 attack styles, and the scripted leg-2 buyer always checks out', async () => {
    const srv = await startFakeServer();
    // Attempts 1-2 leave without leaking; attempt 3 asks for the code and redeems it.
    let attempt = 0;
    const seen: string[] = [];
    const brainFactory: BrainFactory = (persona, ctx) => {
      attempt++;
      seen.push(persona.id);
      return attempt < 3 ? scriptedBrain([act({ action: 'leave' })]) : heuristicBrainFactory(persona, ctx);
    };
    const res = await runNetworkScenario({
      api: new MirageApi(srv.baseUrl, srv.fetch), brainFactory, meter: new CostMeter(5), maxTurns: 6, models,
      batchId: 'net3', outDir: mkdtempSync(join(tmpdir(), 'sim-net-')), log: () => {},
    });
    expect(res.ok).toBe(true);
    expect(res.leg1).toHaveLength(3);
    expect(seen).toEqual(LEG1_ATTACKERS.slice(0, 3)); // leg 2 never asks the brain factory
    expect(res.leg2?.transcript[1].content).toMatch(/I'd like to buy/);
  });

  it('two scenario runs use different Dev payers, so the second still has to be trapped first', async () => {
    const srv = await startFakeServer();
    const run = (batchId: string) => runNetworkScenario({
      api: new MirageApi(srv.baseUrl, srv.fetch), brainFactory: heuristicBrainFactory, meter: new CostMeter(5), maxTurns: 6, models,
      batchId, outDir: mkdtempSync(join(tmpdir(), 'sim-net-')), log: () => {},
    });
    await run('a');
    await run('b');
    expect(srv.blocklist.size).toBe(2);
  });
});
