# Mirage: rules for every agent working in this repo

Mirage gives an AI store agent only FAKE secrets. Anyone who tricks it walks away with traps (self-tracing
codes, fake tools, fake floor prices). When they use a trap at PayPal checkout, PayPal tells us who they are.
Real secrets live only in server code and are never given to the LLM.

PayPal AI Hackathon. Deadline Thu Nov 12 2026, 12:00 PT. Read `docs/PLAN.md` for the full plan.

## Stack
- Node 22 + TypeScript (run with `tsx`), Express 5, `node:sqlite` (no native deps), Vite + React 19, AG Grid Community.
- LLM: `@anthropic-ai/sdk`. Load the `claude-api` skill before writing LLM code. Model ids come from `server/config.ts`.
- PayPal: REST via `fetch` (see `docs/reference-paypal-spike.mjs`, which is proven working against our sandbox)
  plus `@paypal/agent-toolkit` for the store's payment tools.
- Tests: `vitest`. HTTP tests: `supertest`. `npm test`, `npm run typecheck` must pass before any merge.

## Contracts (do not break)
- `shared/types.ts`, `shared/api.ts`: types and HTTP API shared by all workstreams.
- `server/db/schema.sql`: tables. `server/catalog.ts`: stores, products, real secrets (server only).
- Changing a contract = its own commit, called out in the PR/merge description.

## Workstream ownership (each session edits ONLY its own paths, plus new test files)
| Workstream | Owns |
|---|---|
| A core-engine | `server/mirage/**`, `server/agent/**`, `server/db/**` (code), `server/routes/chat.ts`, `server/routes/dashboard.ts`, `server/index.ts`, `server/app.ts` |
| B paypal-layer | `server/paypal/**`, `server/network/**`, `server/routes/checkout.ts`, `server/routes/webhook.ts`, `sim/approver.ts` |
| C dashboard-ui | `web/**` |
| D sim-harness | `sim/**` (except `sim/approver.ts`) |
If you need a change in someone else's path, write it in your final report under "Needs from other workstreams". Don't edit it.

## Hard rules
1. Secrets: read config only through `server/config.ts`. Never print or commit key values. `.secrets/` is gitignored.
2. Sandbox only. `PAYPAL_BASE` must be the sandbox host. Refuse to run if it isn't.
3. The browser must never receive: real floor prices, real codes, decoy registry, `trapped` flags, risk payloads.
   (Dashboard routes are the merchant's own view and may show decoys and trapped status.)
4. Mirage-mode agent prompt never contains real secrets. Baseline mode does, on purpose.
5. Every user-visible message must be TRUE. Trapped flows say "submitted for review" / "pending review",
   never "refund issued" or "order confirmed / shipping".
6. Money decisions (price acceptance, discounts, refunds, capture) happen in server code, never by the LLM.
7. Trapped orders are never captured. Honest orders are captured.
8. Commit small and often on your branch with clear messages. End commit messages with:
   `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`

## Running
- `npm run dev`: server on :8787, web on :5173 (proxies /api).
- `MIRAGE_SIM=1` enables simulated payer injection for sim-created orders (never in the demo deploy).
- `npm run sim -- --help`: attack/honest simulation runner.

## Environment gotchas
- Inside the Claude Code command sandbox, `npm install` and Node network calls (Anthropic, PayPal) can fail with
  `failed to copy trust settings of system certificate`. That is the sandbox, not your code: rerun that command
  outside the sandbox. Unit tests should not need the network (mock the LLM and PayPal).
- `node:sqlite` prints an ExperimentalWarning on Node 22. Ignore it.
