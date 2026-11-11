import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFakeServer } from './fakeServer';
import { MirageApi } from '../api';
import { heuristicBrainFactory, type BrainFactory } from '../brain';
import { CostMeter } from '../cost';
import { resolvePersonas } from '../personas';
import { rescoreBatch } from '../rescore';
import { runBatch } from '../runner';
import { runNetworkScenario } from '../scenarios/network';
import type { SimRun } from '../../shared/types';

const models = { storeAgent: 'claude-haiku-5-5', classifier: 'claude-haiku-5-5' };

describe('rescore', () => {
  it('recomputes runs from stored sessions without any LLM call, rewrites the file and re-posts', async () => {
    const srv = await startFakeServer();
    const api = new MirageApi(srv.baseUrl, srv.fetch);
    const outDir = mkdtempSync(join(tmpdir(), 'sim-rescore-'));
    let brainCalls = 0;
    const counting: BrainFactory = (p, c) => { const b = heuristicBrainFactory(p, c); return { next: (i) => { brainCalls++; return b.next(i); } }; };
    const res = await runBatch({
      api, brainFactory: counting, meter: new CostMeter(5), maxTurns: 6, models, log: () => {}, batchId: 're',
      personas: resolvePersonas('authority,normal_shopper'), storeModes: ['mirage', 'baseline'], runsPerMode: 2,
      stores: ['northpeak'], concurrency: 1, outDir,
    });
    const callsAfterBatch = brainCalls;

    // Corrupt two runs the way an older metric would have scored them.
    const file = res.file;
    const data = JSON.parse(readFileSync(file, 'utf8'));
    const mirageAttack = data.runs.find((r: SimRun) => r.storeMode === 'mirage' && r.isAttack);
    const shopper = data.runs.find((r: SimRun) => r.persona === 'honest.normal_shopper');
    mirageAttack.realSecretLeaked = true;
    shopper.honestOutcomeOk = false;
    data.summary = 'stale';
    writeFileSync(file, JSON.stringify(data));
    const postedBefore = srv.simRuns.length;

    const lines: string[] = [];
    const out = await rescoreBatch({ api, file, log: (l) => lines.push(l) });
    expect(brainCalls).toBe(callsAfterBatch); // no persona LLM involved
    expect(out.changes.map((c) => [c.id, Object.keys(c.fields)])).toEqual(expect.arrayContaining([
      [mirageAttack.id, ['realSecretLeaked']], [shopper.id, ['honestOutcomeOk']],
    ]));
    expect(out.changes).toHaveLength(2);
    expect(out.before.find((s) => s.storeMode === 'mirage')?.realSecretsLeaked).toBe(1);
    expect(out.after.find((s) => s.storeMode === 'mirage')?.realSecretsLeaked).toBe(0);
    expect(out.kept).toEqual([]);

    const rewritten = JSON.parse(readFileSync(file, 'utf8'));
    expect(rewritten.runs).toEqual(res.simRuns); // back to the correct scores
    expect(rewritten.summary).toEqual(out.after);
    expect(rewritten.records).toHaveLength(res.records.length); // records preserved
    expect(rewritten.rescoredAt).toBeTruthy();
    expect(srv.simRuns.length - postedBefore).toBe(res.simRuns.length); // re-posted (server upserts by id)
    expect(lines.at(-1)).toMatch(/rescored 4\/4 runs, 2 changed/);
  });

  it('keeps runs whose session cannot be fetched, and rescores network-scenario files', async () => {
    const srv = await startFakeServer();
    const api = new MirageApi(srv.baseUrl, srv.fetch);
    const outDir = mkdtempSync(join(tmpdir(), 'sim-rescore-'));
    const net = await runNetworkScenario({
      api, brainFactory: heuristicBrainFactory, meter: new CostMeter(5), maxTurns: 6, models, batchId: 'net', outDir, log: () => {},
    });
    const out = await rescoreBatch({ api, file: net.file, log: () => {} });
    expect(out.changes).toEqual([]);
    expect(out.after[0]).toMatchObject({ storeMode: 'mirage', attackRuns: 2, identitiesCaptured: 2 });

    // A server that no longer has the sessions: everything is kept as it was.
    const empty = await startFakeServer();
    const kept = await rescoreBatch({ api: new MirageApi(empty.baseUrl, empty.fetch), file: net.file, post: false, log: () => {} });
    expect(kept.kept).toHaveLength(2);
    expect(kept.after).toEqual(kept.before);
  });

  it('keeps identity fields exactly as stored; only derived metrics are recomputed', async () => {
    const srv = await startFakeServer();
    const api = new MirageApi(srv.baseUrl, srv.fetch);
    const outDir = mkdtempSync(join(tmpdir(), 'sim-rescore-'));
    const res = await runBatch({
      api, brainFactory: heuristicBrainFactory, meter: new CostMeter(5), maxTurns: 6, models, log: () => {}, batchId: 'ids',
      personas: resolvePersonas('authority'), storeModes: ['mirage'], runsPerMode: 1, stores: ['northpeak'], concurrency: 1, outDir,
    });
    const data = JSON.parse(readFileSync(res.file, 'utf8'));
    const identity = {
      batchId: 'renamed-batch', createdAt: '2026-01-01T00:00:00.000Z', persona: 'attacker.custom_label', storeMode: 'mirage',
      storeId: 'northpeak', whiteBox: true, technique: 'Hand-edited label', turns: 99, isAttack: true,
    };
    Object.assign(data.runs[0], identity, { identityCaptured: false });
    writeFileSync(res.file, JSON.stringify(data));
    const out = await rescoreBatch({ api, file: res.file, post: false, log: () => {} });
    const run = JSON.parse(readFileSync(res.file, 'utf8')).runs[0];
    expect(run).toMatchObject({ ...identity, id: res.simRuns[0].id, sessionId: res.simRuns[0].sessionId, identityCaptured: true });
    expect(out.changes).toEqual([{ id: run.id, sessionId: run.sessionId, persona: 'attacker.custom_label', fields: { identityCaptured: [false, true] } }]);
  });

  it('has no import path to server/llm.ts', () => {
    const seen = new Set<string>();
    const walk = (file: string) => {
      if (seen.has(file)) return;
      seen.add(file);
      const src = readFileSync(file, 'utf8');
      for (const m of src.matchAll(/^\s*(?:import|export)\s[^'"]*?from\s+'(\.{1,2}\/[^']+)'/gm)) {
        const target = resolvePath(dirname(file), m[1]);
        walk(existsSync(`${target}.ts`) ? `${target}.ts` : `${target}/index.ts`);
      }
    };
    walk(fileURLToPath(new URL('../rescore.ts', import.meta.url)));
    const files = [...seen].map((f) => f.replace(/^.*?\/(sim|server|shared)\//, '$1/'));
    expect(files).toContain('sim/metrics.ts');
    expect(files.filter((f) => /server\/llm|brain|scenarios\/network|runner/.test(f))).toEqual([]);
  });
});
