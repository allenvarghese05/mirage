// Integration: the sim's heuristic brain against the REAL merged server app (createApp) running the
// MIRAGE_FAKE_LLM=1 script with MIRAGE_SIM=1 and an in-memory DB. No sockets, no LLM, no PayPal network.
import { beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MirageApi as MirageApiT } from '../api';

const models = { storeAgent: 'claude-haiku-5-5', classifier: 'claude-haiku-5-5' };
let api: MirageApiT;
let mod: {
  runBatch: typeof import('../runner').runBatch;
  runNetworkScenario: typeof import('../scenarios/network').runNetworkScenario;
  heuristicBrainFactory: typeof import('../brain').heuristicBrainFactory;
  resolvePersonas: typeof import('../personas').resolvePersonas;
  CostMeter: typeof import('../cost').CostMeter;
  STORES: typeof import('../../server/catalog').STORES;
};

beforeAll(async () => {
  // Config is read at import time, so set the switches before importing the server.
  process.env.MIRAGE_FAKE_LLM = '1';
  process.env.MIRAGE_SIM = '1';
  process.env.MIRAGE_DB = ':memory:';
  process.env.MIRAGE_LLM_LEDGER = join(mkdtempSync(join(tmpdir(), 'sim-real-')), 'spend.jsonl');
  const { createApp } = await import('../../server/app');
  const { inProcessFetch } = await import('./inProcessFetch');
  const { MirageApi } = await import('../api');
  api = new MirageApi('http://mirage.local', inProcessFetch(createApp() as never));
  mod = {
    runBatch: (await import('../runner')).runBatch,
    runNetworkScenario: (await import('../scenarios/network')).runNetworkScenario,
    heuristicBrainFactory: (await import('../brain')).heuristicBrainFactory,
    resolvePersonas: (await import('../personas')).resolvePersonas,
    CostMeter: (await import('../cost')).CostMeter,
    STORES: (await import('../../server/catalog')).STORES,
  };
});

describe('heuristic wiring against the real server (MIRAGE_FAKE_LLM=1, MIRAGE_SIM=1)', () => {
  it('wiring batch: mirage leaks decoys and identifies attackers; baseline leaks real codes and loses money', async () => {
    const res = await mod.runBatch({
      api, brainFactory: mod.heuristicBrainFactory, meter: new mod.CostMeter(5), maxTurns: 12, models, log: () => {},
      batchId: 'wiring', personas: mod.resolvePersonas('all'), storeModes: ['mirage', 'baseline'], runsPerMode: 12,
      concurrency: 4, outDir: mkdtempSync(join(tmpdir(), 'sim-real-')),
    });
    const errors = res.records.filter((r) => r.endReason === 'error').map((r) => `${r.personaId}: ${r.error}`);
    expect(errors).toEqual([]);
    expect(res.excluded).toEqual([]);
    const [mirage, baseline] = res.summary;
    expect(mirage).toMatchObject({ storeMode: 'mirage', realSecretsLeaked: 0, dollarsLostCents: 0, attributionAccuracy: 1 });
    expect(mirage.leakRate).toBeGreaterThan(0);
    expect(mirage.identitiesCaptured).toBeGreaterThan(0);
    expect(baseline.storeMode).toBe('baseline');
    expect(baseline.realSecretsLeaked).toBeGreaterThan(0);
    expect(baseline.dollarsLostCents).toBeGreaterThan(0);
    const realCodes = new Set(Object.values(mod.STORES).map((s) => s.realStaffCode));
    const staffCodeRuns = res.simRuns.filter((r) => r.storeMode === 'baseline' && r.dollarsLostCents > 0
      && realCodes.has(res.records.find((x) => x.runId === r.id)?.checkout?.req.code ?? ''));
    expect(staffCodeRuns.length).toBeGreaterThan(0);
    expect(res.posted.ok).toBe(true);
  });

  it('network scenario passes', async () => {
    const res = await mod.runNetworkScenario({
      api, brainFactory: mod.heuristicBrainFactory, meter: new mod.CostMeter(5), maxTurns: 12, models,
      batchId: 'net-real', outDir: mkdtempSync(join(tmpdir(), 'sim-real-')), log: () => {},
    });
    expect(res.reason).toMatch(/NETWORK_MATCH/);
    expect(res.ok).toBe(true);
  });
});
