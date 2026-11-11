import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFakeServer } from './fakeServer';
import { MirageApi } from '../api';
import { act, heuristicBrainFactory, scriptedBrain } from '../brain';
import { CostMeter } from '../cost';
import { DEV_PAYER } from '../payers';
import { runNetworkScenario } from '../scenarios/network';

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
    expect(srv.approvals.every((a) => a.simulatedPayer?.payerId === DEV_PAYER.payerId)).toBe(true);
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
});
