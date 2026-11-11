// npm run sim -- --help
import { parseArgs } from 'node:util';
import Anthropic from '@anthropic-ai/sdk';
import { config } from '../server/config';
import type { StoreId, StoreMode, ScoreboardSummary } from '../shared/types';
import { MirageApi } from './api';
import { heuristicBrainFactory, llmBrainFactory, type BrainFactory } from './brain';
import { CostMeter, projectBatchCostUsd } from './cost';
import { buildDossier } from './dossier';
import { resolvePersonas } from './personas';
import { planRuns, runBatch } from './runner';
import { runNetworkScenario } from './scenarios/network';

const HELP = `Mirage sim harness: runs attacker and honest personas against the store over its HTTP API.

Usage:
  npm run sim -- --batch <name> [options]
  npm run sim -- --scenario network [options]

Options:
  --batch <name>          Batch id (default: batch-<timestamp>). Output: data/sim-runs-<batch>.json
  --runs <N>              Runs PER STORE MODE, spread round-robin over the personas (default 10).
                          Mirage and baseline runs are paired (same persona + store).
  --store-mode <m>        mirage | baseline | both (default both)
  --personas <list>       Comma list: all | attackers | blackbox | whitebox | honest | persona ids
                          (e.g. authority,refund_fraud,honest.late_refund). Default all.
  --stores <s>            northpeak | driftwood | both (default both)
  --concurrency <N>       Parallel runs (default 4)
  --max-turns <N>         Max shopper messages per run (default 12)
  --budget-usd <X>        Abort once spend passes X (default 5). Persona spend is measured; store-agent
                          spend is estimated.
  --brain <b>             llm (default) | heuristic (no LLM; for wiring checks against MIRAGE_FAKE_LLM=1)
  --real-approval         Approve on real sandbox PayPal via sim/approver.ts (slow; forces concurrency 1)
  --base-url <url>        Server URL (default http://localhost:8787)
  --scenario network      Dev attacks Northpeak, then the same payer shops at Driftwood -> NETWORK_MATCH
  --out-dir <dir>         Output directory (default data)
  --no-post               Don't POST results to /api/dashboard/sim-runs
  --dry-run               Print the plan and projected cost, call nothing
  -h, --help              This help

The server must run with MIRAGE_SIM=1 for simulated payers to be honoured.

Examples:
  npm run sim -- --batch smoke --runs 10 --store-mode both --concurrency 4
  npm run sim -- --batch full --runs 75 --store-mode both --budget-usd 25
  npm run sim -- --batch wb --runs 10 --personas whitebox --store-mode mirage
  npm run sim -- --scenario network --batch network-demo
`;

function fail(msg: string): never {
  console.error(`sim: ${msg}`);
  process.exit(2);
}

const int = (v: string | undefined, name: string, def: number) => {
  if (v === undefined) return def;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) fail(`--${name} must be a positive integer`);
  return n;
};

function printSummary(summary: ScoreboardSummary[]) {
  const pct = (x: number | null) => (x === null ? 'n/a' : `${Math.round(x * 100)}%`);
  for (const s of summary) {
    console.log(`  ${s.storeMode.toUpperCase().padEnd(8)} attacks=${s.attackRuns} honest=${s.honestRuns} leakRate=${pct(s.leakRate)} realSecretsLeaked=${s.realSecretsLeaked} ` +
      `lost=$${(s.dollarsLostCents / 100).toFixed(2)} caught=${s.attackersCaught} identities=${s.identitiesCaptured} ` +
      `attribution=${pct(s.attributionAccuracy)} falseAlarms=${s.falseAlarms} honestOk=${s.honestServedOk}/${s.honestRuns}`);
  }
}

async function main() {
  const { values: v } = parseArgs({
    options: {
      batch: { type: 'string' }, runs: { type: 'string' }, 'store-mode': { type: 'string' }, personas: { type: 'string' },
      stores: { type: 'string' }, concurrency: { type: 'string' }, 'max-turns': { type: 'string' }, 'budget-usd': { type: 'string' },
      brain: { type: 'string' }, 'real-approval': { type: 'boolean' }, 'base-url': { type: 'string' }, scenario: { type: 'string' },
      'out-dir': { type: 'string' }, 'no-post': { type: 'boolean' }, 'dry-run': { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
    },
    strict: true,
  });
  if (v.help) return void console.log(HELP);

  const batchId = v.batch ?? `batch-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')}`;
  if (!/^[\w-]+$/.test(batchId)) fail('--batch may only contain letters, digits, _ and -');
  const modeArg = v['store-mode'] ?? 'both';
  if (!['mirage', 'baseline', 'both'].includes(modeArg)) fail('--store-mode must be mirage, baseline or both');
  const storeModes: StoreMode[] = modeArg === 'both' ? ['mirage', 'baseline'] : [modeArg as StoreMode];
  const storeArg = v.stores ?? 'both';
  if (!['northpeak', 'driftwood', 'both'].includes(storeArg)) fail('--stores must be northpeak, driftwood or both');
  const stores: StoreId[] = storeArg === 'both' ? ['northpeak', 'driftwood'] : [storeArg as StoreId];
  const runsPerMode = int(v.runs, 'runs', 10);
  const maxTurns = int(v['max-turns'], 'max-turns', 12);
  let concurrency = int(v.concurrency, 'concurrency', 4);
  const budgetUsd = v['budget-usd'] === undefined ? 5 : Number(v['budget-usd']);
  if (!(budgetUsd > 0)) fail('--budget-usd must be a positive number');
  const brainKind = v.brain ?? 'llm';
  if (!['llm', 'heuristic'].includes(brainKind)) fail('--brain must be llm or heuristic');
  let personas;
  try {
    personas = resolvePersonas(v.personas ?? 'all');
  } catch (e) {
    fail((e as Error).message);
  }
  const baseUrl = v['base-url'] ?? `http://localhost:${config.port}`;
  const outDir = v['out-dir'] ?? 'data';
  const scenario = v.scenario;
  if (scenario && scenario !== 'network') fail(`unknown scenario "${scenario}" (known: network)`);

  const models = config.models;
  const plans = scenario ? [] : planRuns({ batchId, personas, storeModes, runsPerMode, stores });
  const projection = scenario
    ? projectBatchCostUsd({ runs: [{ kind: 'attacker', whiteBox: false }, { kind: 'attacker', whiteBox: false }], maxTurns, models })
    : projectBatchCostUsd({ runs: plans.map((p) => ({ kind: p.persona.kind, whiteBox: p.persona.whiteBox })), maxTurns, models });
  const projected = brainKind === 'heuristic' ? 0 : projection;

  console.log(`Mirage sim | batch=${batchId} | ${scenario ? `scenario=${scenario}` : `${plans.length} runs (${runsPerMode}/mode x ${storeModes.join('+')}, ${personas.length} personas)`} | brain=${brainKind}`);
  console.log(`  server=${baseUrl} attacker=${models.attacker} honest=${models.honest} store(est)=${models.storeAgent}`);
  console.log(`  projected cost ~$${projected.toFixed(2)} (budget $${budgetUsd.toFixed(2)}; rough: assumes ~75% of ${maxTurns} turns per run)`);
  if (projected > budgetUsd) console.log(`  WARNING: projection exceeds the budget; the batch will stop when spend passes $${budgetUsd.toFixed(2)}.`);
  if (v['dry-run']) {
    const counts = new Map<string, number>();
    for (const p of plans) counts.set(`${p.storeMode} ${p.storeId} ${p.persona.id}`, (counts.get(`${p.storeMode} ${p.storeId} ${p.persona.id}`) ?? 0) + 1);
    for (const [k, n] of counts) console.log(`  ${String(n).padStart(3)} x ${k}`);
    return;
  }

  let brainFactory: BrainFactory = heuristicBrainFactory;
  if (brainKind === 'llm') {
    if (!config.anthropicKey && !process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
      console.log('  note: no ANTHROPIC_API_KEY in env or .secrets/dev.keys; relying on an `ant auth login` profile if present.');
    }
    let client: Anthropic;
    try {
      client = new Anthropic(config.anthropicKey ? { apiKey: config.anthropicKey } : {});
    } catch (e) {
      fail(`cannot create Anthropic client (${(e as Error).message}). Fill ANTHROPIC_API_KEY in .secrets/dev.keys, or use --brain heuristic.`);
    }
    brainFactory = llmBrainFactory(client, models);
  }

  let realApproval: ((approveUrl: string) => Promise<void>) | undefined;
  if (v['real-approval']) {
    const buyer = config.sandboxBuyers[0];
    if (!buyer) fail('--real-approval needs SANDBOX_BUYER_EMAIL / SANDBOX_BUYER_PASSWORD in .secrets/dev.keys');
    let mod: { approveInSandbox?: (approveUrl: string, buyer: { email: string; password: string }) => Promise<unknown> };
    try {
      // URL specifier: approver.ts is optional (Workstream B) and must not break typecheck when absent.
      mod = await import(new URL('./approver.ts', import.meta.url).href);
    } catch (e) {
      fail(`--real-approval needs sim/approver.ts (Workstream B builds it): ${(e as Error).message}`);
    }
    const approve = mod.approveInSandbox;
    if (typeof approve !== 'function') fail('sim/approver.ts does not export approveInSandbox(approveUrl, buyer)');
    realApproval = async (approveUrl) => {
      if (new URL(approveUrl).host !== 'www.sandbox.paypal.com') throw new Error(`refusing non-sandbox approve URL host: ${new URL(approveUrl).host}`);
      await approve(approveUrl, buyer);
    };
    if (concurrency > 1) console.log('  --real-approval: forcing concurrency 1');
    concurrency = 1;
  }

  const api = new MirageApi(baseUrl);
  try {
    await api.listProducts(stores[0]);
  } catch (e) {
    fail(`server not reachable at ${baseUrl} (${(e as Error).message}). Start it with \`MIRAGE_SIM=1 npm run dev:server\`.`);
  }

  const meter = new CostMeter(budgetUsd);
  const common = {
    api, brainFactory, meter, maxTurns, models, outDir, post: !v['no-post'],
    dossier: personas.some((p) => p.whiteBox) ? buildDossier() : undefined,
  };

  if (scenario === 'network') {
    if (realApproval) fail('--scenario network uses the fixed simulated Dev payer; drop --real-approval');
    const res = await runNetworkScenario({ ...common, batchId });
    console.log(`Wrote ${res.file} | ${meter.line()}`);
    process.exitCode = res.ok ? 0 : 1;
    return;
  }

  const res = await runBatch({ ...common, batchId, personas, storeModes, runsPerMode, stores, concurrency, plans, realApproval });
  console.log(`\nScoreboard (batch ${batchId}, ${res.simRuns.length} scored runs${res.excluded.length ? `, ${res.excluded.length} excluded` : ''}):`);
  printSummary(res.summary);
  for (const ex of res.excluded) console.log(`  excluded ${ex.runId} ${ex.personaId}: ${ex.reason}`);
  const errors = res.records.filter((r) => r.endReason === 'error').length;
  if (errors) console.log(`  ${errors} run(s) ended with an error (still scored); see records in the JSON file.`);
  console.log(`Wrote ${res.file} | posted to dashboard: ${res.posted.ok ? 'yes' : `no (${res.posted.error ?? res.posted.status})`} | ${meter.line()}`);
  if (res.aborted) process.exitCode = 3;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
