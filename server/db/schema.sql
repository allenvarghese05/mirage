-- SQLite schema (node:sqlite). Owned by workstream A; others add tables only via a PR that says so.
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  store_id TEXT NOT NULL,
  store_mode TEXT NOT NULL DEFAULT 'mirage',
  mode TEXT NOT NULL DEFAULT 'normal',          -- normal | shadow
  seq INTEGER NOT NULL,                          -- small integer encoded into self-tracing codes
  client_metadata_id TEXT NOT NULL,              -- sent to PayPal as PayPal-Client-Metadata-Id
  ip TEXT, user_agent TEXT,
  sim_run_id TEXT,
  agent_profile TEXT,                            -- realistic | hardened (store-agent prompt profile at session start)
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL, role TEXT NOT NULL,
  content TEXT NOT NULL, tool_name TEXT, at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS decoys (
  code TEXT PRIMARY KEY,                         -- for fake_floor: 'floor:<productId>:<cents>:<sessionId>'
  session_id TEXT NOT NULL, kind TEXT NOT NULL, product_id TEXT, value_cents INTEGER,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY, at TEXT NOT NULL, store_id TEXT NOT NULL, session_id TEXT NOT NULL,
  kind TEXT NOT NULL, severity TEXT NOT NULL, detail_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS quotes (
  session_id TEXT NOT NULL, product_id TEXT NOT NULL, agreed_cents INTEGER NOT NULL, at TEXT NOT NULL,
  PRIMARY KEY (session_id, product_id)
);
CREATE TABLE IF NOT EXISTS orders (
  order_id TEXT PRIMARY KEY,                     -- PayPal order id (or SIM-xxxx in sim without PayPal)
  session_id TEXT NOT NULL, store_id TEXT NOT NULL, total_cents INTEGER NOT NULL,
  code_used TEXT, trapped INTEGER NOT NULL DEFAULT 0, trap_source_session TEXT,
  status TEXT NOT NULL,                          -- AWAITING_APPROVAL | COMPLETED | PENDING_REVIEW | CANCELLED
  payer_id TEXT, payer_json TEXT, capture_id TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS refunds (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL, order_ref TEXT, amount_cents INTEGER NOT NULL,
  kind TEXT NOT NULL,                            -- policy | shadow | baseline_override
  executed INTEGER NOT NULL DEFAULT 0, paypal_refund_id TEXT, at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS blocklist (
  payer_id TEXT PRIMARY KEY, first_seen_store TEXT NOT NULL, first_session_id TEXT NOT NULL,
  reason TEXT NOT NULL, hits INTEGER NOT NULL DEFAULT 0, at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS risk_payloads (
  id TEXT PRIMARY KEY, at TEXT NOT NULL, session_id TEXT NOT NULL, order_id TEXT,
  ok INTEGER NOT NULL, http_status INTEGER, body_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sim_runs (
  id TEXT PRIMARY KEY, batch_id TEXT NOT NULL, run_json TEXT NOT NULL, created_at TEXT NOT NULL
);
-- Seed orders an honest customer can legitimately ask to refund (policy path).
CREATE TABLE IF NOT EXISTS past_orders (
  ref TEXT PRIMARY KEY, store_id TEXT NOT NULL, customer_email TEXT NOT NULL, product_id TEXT NOT NULL,
  paid_cents INTEGER NOT NULL, purchased_at TEXT NOT NULL, refunded INTEGER NOT NULL DEFAULT 0,
  paypal_capture_id TEXT
);
