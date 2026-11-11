// Test helpers for the PayPal layer: an in-memory DB with the contract schema, an event collector,
// a scripted traceCode and the fake PayPal. Not used at runtime.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import type { DecoyKind, StoreId, StoreMode, TripEvent } from '../../shared/types';
import { createFakePayPal, type FakePayPal } from './fake';
import type { EmitInput, PaypalLayerConfig, PaypalLayerDeps } from './deps';
import { createToolkitRunner, type ToolkitTools } from './toolkit';

export function memoryDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(fileURLToPath(new URL('../db/schema.sql', import.meta.url)), 'utf8'));
  return db;
}

let seq = 0;
export function addSession(db: DatabaseSync, o: {
  id: string; storeId?: StoreId; storeMode?: StoreMode; simRunId?: string | null; ip?: string | null; userAgent?: string | null;
}): void {
  db.prepare(`INSERT INTO sessions (id, store_id, store_mode, mode, seq, client_metadata_id, ip, user_agent, sim_run_id, created_at)
              VALUES (?, ?, ?, 'normal', ?, ?, ?, ?, ?, ?)`).run(
    o.id, o.storeId ?? 'northpeak', o.storeMode ?? 'mirage', ++seq, `cmid-${o.id}`,
    o.ip ?? null, o.userAgent ?? null, o.simRunId ?? null, new Date().toISOString(),
  );
}

export interface TestDeps extends PaypalLayerDeps {
  db: DatabaseSync;
  events: TripEvent[];
  codes: Map<string, { sessionId: string; kind: DecoyKind }>;
  pp: FakePayPal;
  sim: FakePayPal;
  /** Fake Agent Toolkit tools (AI SDK shape); tests may replace entries. */
  toolkitTools: ToolkitTools;
}

export function makeTestDeps(cfg: Partial<PaypalLayerConfig> = {}): TestDeps {
  const db = memoryDb();
  const events: TripEvent[] = [];
  const codes = new Map<string, { sessionId: string; kind: DecoyKind }>();
  const pp = createFakePayPal();
  const sim = createFakePayPal({ idPrefix: 'SIM-' });
  let n = 0;
  const toolkitTools: ToolkitTools = {
    list_transactions: { execute: async () => JSON.stringify({ transaction_details: [] }) },
  };
  const toolkitRunner = createToolkitRunner({ tools: () => toolkitTools });
  return {
    db, events, codes, pp, sim, toolkitTools,
    toolkit: () => toolkitRunner,
    getDb: () => db,
    traceCode: (code) => codes.get(code.trim().toUpperCase()) ?? null,
    emit: (e: EmitInput) => {
      const ev = { ...e, id: `ev${++n}`, at: new Date().toISOString() } as TripEvent;
      events.push(ev);
      return ev;
    },
    paypal: () => pp,
    simPaypal: () => sim,
    config: {
      sim: false, merchantId: 'MERCH1', webhookId: '', publicBaseUrl: 'http://localhost:5173',
      production: false, hasPaypalKeys: true, ...cfg,
    },
  };
}

export const kinds = (d: TestDeps) => d.events.map((e) => e.kind);
