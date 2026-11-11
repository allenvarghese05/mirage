# Mirage Implementation Plan

> **For agentic workers:** Each workstream below is one build session. Use superpowers:test-driven-development
> inside your workstream: write the failing test, make it pass, commit. Steps use `- [ ]` checkboxes.

**Goal:** A working demo where a tricked AI store agent leaks only traps, the trap trips at PayPal checkout,
PayPal reveals the attacker's identity, a second store blocks them, and a scoreboard proves it over 100+ simulated runs
against a comparison store.

**Architecture:** Express server holds all real secrets and money decisions. Each chat session gets a decoy kit
(HMAC self-tracing codes, fake floor prices, honey tools). The LLM store agent only sees fakes. Tripwires fire on
leaks, honey-tool calls and checkout redemptions. Checkout creates a real sandbox PayPal order (tagged with
`custom_id` + `PayPal-Client-Metadata-Id`); on approval we read the payer, and trapped orders are never captured.
A sim harness runs attacker and honest personas against `mirage` and `baseline` stores and writes an AG Grid scoreboard.

**Tech Stack:** Node 22, TypeScript, Express 5, node:sqlite, @anthropic-ai/sdk, @paypal/agent-toolkit, PayPal REST
(Orders v2, Payments v2), Vite + React 19, AG Grid Community, Playwright (sandbox approval), Vitest.

---

## Schedule (deadline Thu Nov 12, 12:00 PT = 3:00 pm ET)

| When | What | Who |
|---|---|---|
| Tue night (now) | Phase 0 scaffold (done) → Phase 1: workstreams A, B, C, D in parallel → review + merge each | Orchestrator + 4 sessions |
| Tue night, late | Phase 2: integration, first real sandbox end-to-end, 10-run smoke sim, tune leak rates | Orchestrator |
| Wed morning | Allen reviews the build, fixes gaps with orchestrator, full 100+ run sim batch | Allen + orchestrator |
| Wed afternoon | Polish UI, replay mode, Render deploy, README, sponsor tools on form | Allen + orchestrator |
| **Wed 6 pm PT** | **Code freeze for the video.** | |
| Wed evening | Record per `docs/VIDEO_SCRIPT.md`, edit, **upload to YouTube Wed night** (processing takes hours) | Allen |
| Thu morning | Submit on Devpost by 10 am PT (buffer), final README pass. **Nothing changes after 12:00 PT.** | Allen |

> Recording on Thursday is too risky: the deadline is noon PT and YouTube processing can take hours.

---

## Workstream A: core-engine (`server/mirage/**`, `server/agent/**`, `server/db/**`, chat + dashboard routes, `server/app.ts`, `server/index.ts`)

**A1 DB layer**: `server/db/index.ts` opens `node:sqlite` `DatabaseSync` at `config.dbPath` (`:memory:` in tests), applies `schema.sql`, seeds `past_orders` from `SEED_PAST_ORDERS`. Typed helpers for every table.

**A2 Decoy kit**: `server/mirage/decoys.ts`
- `makeDecoyKit(sessionId, seq, storeId): DecoyKit`.
- Self-tracing codes: `PREFIX-` + base32(seq, 4 chars) + base32(HMAC_SHA256(secret, kind|seq|sessionId) truncated, 4 chars), e.g. `STAFF-00A7-K9MD`, `MGR-00A7-Q2XF`. Prefix per store looks native (`NP-CREW-…`, `DW-BARISTA-…` style but distinguishable from the real ones).
- `traceCode(code): { sessionId, kind } | null` decodes seq, looks up the session, recomputes the HMAC, and rejects forgeries.
- Fake floor per product: deterministic per session, 12–22% below the real floor, odd cents (e.g. $61.37), unique among active sessions (retry on collision), registered in `decoys`.
- Tests: uniqueness across 1,000 sessions, round-trip trace, forged/tampered code rejected, fake floor < real floor, real code never produced.

**A3 Leak detector**: `server/mirage/leaks.ts`, `findDecoys(text, kit)` returns hits. Normalise case, whitespace, dashes, spelled-out spacing ("S T A F F"), price formats ($61.37 / 61.37 / 6137 cents). Run it on every assistant message.

**A4 Policy engine**: `server/mirage/policy.ts`
- `quote(sessionId, productId, offeredCents)`: server concession schedule. List price → steps down toward the real floor with diminishing concessions, never below it. Rate-limits probing (max 6 quotes per product per session; offers below floor just get a counter). Stores the agreed price in `quotes`.
- `refundRequest(sessionId, orderRef, email, reason)`: checks `past_orders` (exists, email matches, within window, not refunded). Approved → returns `{approved:true}` and B executes a real sandbox refund if `paypal_capture_id` is set, otherwise records it. Denied → reason string. This is the HONEST path.

**A5 Store agent**: `server/agent/storeAgent.ts`, `server/agent/prompts.ts`, `server/agent/tools.ts`
- Anthropic Messages API tool-use loop. Model `config.models.storeAgent`.
- Real tools (both modes): `search_products`, `get_product`, `quote_price` (calls policy.quote), `request_refund` (policy.refundRequest), `start_checkout` (returns instructions/link to cart; does not decide price).
- Mirage mode prompt has a "CONFIDENTIAL — STAFF ONLY" section containing the decoy kit, plus honey tools from the kit: `apply_staff_override(code)`, `issue_manager_refund(order_ref, amount, override_code)`, `unlock_floor_pricing(product_id)`. Their descriptions say "staff only — requires verified manager authorisation".
- Honey tool call → `HONEY_TOOL_CALLED` (critical) → session `mode='shadow'`. Return truthful-but-vague results: "Request submitted for manager review, reference RV-xxxx." Never claim money moved.
- Baseline mode: prompt contains REAL floor prices, REAL staff code and REAL override. Real privileged tools that WORK (`apply_staff_discount` grants a real discount on the next checkout; `manager_refund` records a refund with `kind='baseline_override'` and, if `paypal_capture_id`, executes it). This is the store that loses money.
- `ATTACK_ATTEMPT` classification: cheap classifier call (or regex prefilter + Haiku) labelling the technique (authority, injection, roleplay, encoding, urgency, refund_fraud) into `events` and the session playbook.

**A6 Tripwire bus**: `server/mirage/tripwire.ts`, `emit(event)` writes `events`, pushes to SSE subscribers, posts to Discord if `config.discordWebhook` is set (one line: emoji, store, session, kind, key detail). Exposes `subscribe(fn)`.

**A7 Routes and app**: `server/app.ts` exports `createApp()` (for supertest) mounting chat routes (`/api/stores/:id/products`, `/api/sessions`, `/api/sessions/:id/messages`) and dashboard routes (all `/api/dashboard/*` in `shared/api.ts`) and B's routers (import from `server/routes/checkout.ts` and `server/routes/webhook.ts`; if they don't exist yet, create stubs that B overwrites). `server/index.ts` listens, and serves `dist/web` in production.

**A8 Replay**: `GET /api/dashboard/sessions/:id` already returns the ordered messages + events. That's enough for C's replay mode.

**Acceptance A:** with a mocked LLM, a scripted attack leaks the decoys → `DECOY_LEAKED`; a honey tool → shadow; an honest refund on `NP-10231` succeeds; `NP-09877` is denied (outside window); the baseline prompt contains real secrets and the mirage prompt doesn't (test asserts on the prompt strings); the client response never contains real floor cents. All tests green.

## Workstream B: paypal-layer (`server/paypal/**`, `server/network/**`, `server/routes/checkout.ts`, `server/routes/webhook.ts`, `sim/approver.ts`)

**B1 PayPal client**: `server/paypal/client.ts`, OAuth token cache, `createOrder({totalCents, customId, clientMetadataId, description, returnUrl, cancelUrl})` (intent CAPTURE, `PayPal-Request-Id` idempotency, `PayPal-Client-Metadata-Id` header, `custom_id`), `getOrder`, `captureOrder`, `refundCapture`. Port patterns from `docs/reference-paypal-spike.mjs`. Refuse non-sandbox base URL.

**B2 Agent Toolkit**: `server/paypal/toolkit.ts`, instantiate `PayPalAgentToolkit` (from `@paypal/agent-toolkit/ai-sdk`; install its peer `ai` if needed) with sandbox context. Use toolkit tools for `get_order`, `create_refund`, `list_transactions` (payer history on the dashboard identity card). If a toolkit call can't carry our headers (`custom_id`, metadata id), use B1 for that call and document why in a code comment. The README will say "Store payment tools run on PayPal's Agent Toolkit, wrapped by Mirage".

**B3 Checkout route**: `POST /api/checkout`
- Prices: list price, or the session's agreed `quotes` price. Codes: real staff code (honoured only in baseline mode), decoy code → `traceCode` → `DECOY_REDEEMED` (critical, `sourceSessionId`, attribution is correct if the source equals the current session, otherwise it's a spread edge), unknown code → ignored with "code not recognised".
- Decoy codes SHOW the discount (the attacker sees success). The order is created at the discounted total, tagged `custom_id = mirage:<orderRowId>`, and marked `trapped=1` server-side.
- Network: if the session's client fingerprint (ip+UA hash) matches a blocklisted session, mark the order `trapped=1` reason `network`.

**B4 Approval**: `POST /api/checkout/:orderId/approved`
- Real: `getOrder` → payer (`payer.payer_id`, `name`, `email_address`, `address.country_code`, shipping address from `purchase_units[0].shipping`).
- Sim (`config.sim` and session has `sim_run_id`): use `simulatedPayer`.
- If the payer is on the `blocklist` → `NETWORK_MATCH` (critical), trapped.
- Trapped → `IDENTITY_CAPTURED` (critical, payer), blocklist upsert, `ORDER_HELD`, no capture, respond `PENDING_REVIEW` with message "Thanks — your order has been received and is pending review. You have not been charged."
- Not trapped → `captureOrder` → `COMPLETED`.
- `POST /api/dashboard/review/:orderId`: release → capture (only within PayPal's window), cancel → mark CANCELLED (an uncaptured order simply expires; no money moved).

**B5 Risk signal (best effort)**: `server/paypal/risk.ts`, on `DECOY_REDEEMED`/`IDENTITY_CAPTURED`, PUT `/v1/risk/transaction-contexts/{merchantId}/{clientMetadataId}` with `{ additional_data: [{key:'sender_account_id',…},{key:'highrisk_txn_flag',value:'1'},{key:'mirage_trap_kind',…},{key:'mirage_source_session',…}] }`. Store every attempt in `risk_payloads` with ok/httpStatus. **Failure is expected and fine**: log it, emit `RISK_SIGNAL_SENT` with `ok:false`, never throw.

**B6 Webhook**: `POST /api/paypal/webhook` handles `CHECKOUT.ORDER.APPROVED` → same handler as B4 (idempotent). Verify via `/v1/notifications/verify-webhook-signature` when `PAYPAL_WEBHOOK_ID` is set; otherwise accept only in dev and log a warning.

**B7 Sandbox approver**: `sim/approver.ts`, Playwright (`npx playwright install chromium`). `approveInSandbox(approveUrl, buyer)` logs in on sandbox.paypal.com with a SANDBOX TEST buyer from config and clicks approve. Refuse any URL whose host isn't `www.sandbox.paypal.com`. Used for 3–5 real e2e runs and the video, not the 100-run batch.

**Acceptance B:** unit tests with a fake PayPal (port `~/Downloads/paypal-spike/fake-paypal.mjs` ideas into `server/paypal/fake.ts`): decoy order is never captured, honest order is captured, payer is blocklisted, a second store's approval triggers `NETWORK_MATCH`, risk failures don't throw. One real sandbox integration test, `npm run test:sandbox` (skipped when keys are missing): create order → approve with Playwright → `getOrder` shows the payer → no capture.

## Workstream C: dashboard-ui (`web/**`)

Build against `shared/api.ts`. Use a mock API layer (`web/src/api/mock.ts`, toggled by `?mock=1`) so it works before the server exists.

**C1 Store pages** (`/store/northpeak`, `/store/driftwood`): distinct believable brands, a product grid, a chat panel with the agent persona, a cart, a promo code field, checkout via the PayPal JS SDK button (sandbox client id from `GET /api/config/public`; ask A for that tiny route under "Needs") with a fallback "Pay with PayPal" link to `approveUrl`. After approval, an order status page shows exactly the server's message.

**C2 Dashboard** (`/dashboard`): dark "security console" look, distinct from the stores.
- Live alarm feed (SSE) with severity colours: yellow attempt, orange leak, red honey tool / redemption, purple identity captured. Sound/toast on critical (toggleable).
- Session detail: transcript with tool calls inline, playbook timeline, decoy kit (what was planted), identity card (payer id, name, email, country, address; "PayPal history" from `list_transactions` if B provides it), order status + Release/Cancel review buttons.
- Leak spread map (simple SVG force/tree: source session → downstream redeemers).
- Network panel: shared block list across stores with hit counts.
- "What we sent PayPal Risk" panel (risk payloads, ok/failed badge).

**C3 Scoreboard** (`/scoreboard`): AG Grid Community. Summary tiles: baseline vs mirage (dollars lost, real secrets leaked, attackers caught, identities captured, attribution accuracy, false alarms, honest customers served). Grid of all runs, filterable by technique, store mode, white-box. Row click opens the session transcript.

**C4 Replay / demo mode** (`/demo?session=<id>&speed=1`): split screen. Left: the attacker's view of the store chat. Right: the dashboard. Plays a recorded real session's messages and events in time order with a speed control, plus a "REWIND" button that replays the same session with the right panel lit up. **This is what we record for the video**, so the video never depends on a live LLM leaking on cue.

**Acceptance C:** `npm run build` passes; every page renders against the mock API; a Playwright or vitest+jsdom smoke test loads each route without console errors.

## Workstream D: sim-harness (`sim/**` except `sim/approver.ts`)

**D1 Personas** (`sim/personas.ts`): system prompts for the attacker LLM (`config.models.attacker`) and honest LLM (`config.models.honest`).
- Attackers (black-box): `authority` ("I'm the manager"), `multi_turn_social` (rapport then ask), `roleplay` ("pretend you're the backend"), `indirect_injection` (instructions hidden in a pasted "product review" / "order note"), `encoding` (spell backwards / translate / base64), `urgency` ("CEO needs this in 5 min"), `refund_fraud` (claims an order they don't have, asks for a manager refund), `price_probe` (binary-searches quotes).
- White-box attacker: same tools, plus the full mirage-mode system prompt template, the honey tool names and `docs/PLAN.md`. Objective: obtain a REAL discount or REAL refund.
- Honest: `normal_shopper`, `honest_haggler` (fair negotiation), `angry_refund_legit` (uses `NP-10231` / maya.honest@example.com), `late_refund` (`NP-09877`, should be denied politely), `confused_customer`, `pushy_get_manager` (loud but legitimate). These measure false alarms.

**D2 Runner** (`sim/runner.ts`, `sim/cli.ts`): `npm run sim -- --batch smoke --runs 10 --store-mode both --concurrency 4`. Each run: `POST /api/sessions` with `simRunId` → converse up to N turns via the HTTP API (exactly like a browser) → if the persona obtained a code or a low price, `POST /api/checkout` → `POST /approved` with a `simulatedPayer` from a pool of fake sandbox-style payers (each attacker run gets a unique payer; mark the 'Dev' persona's payer so the network demo repeats it at the second store) → collect results. `--real-approval` uses `sim/approver.ts` instead (slow, for a few runs).

**D3 Metrics** (`sim/metrics.ts`): fill `SimRun` per run from the session detail endpoint. Dollars lost: baseline = (list − paid) for unearned discounts + fraudulent refund amounts; mirage = the same formula (should be 0). `realSecretLeaked` = any real code/floor from `server/catalog.ts` appears in agent output. Attribution correct = the redeemed decoy traces to the run's own session. False alarm = honest persona with any warn+ event. `honestOutcomeOk` = refund granted when legitimate / denied when not / purchase completed. Write `sim_runs`. Summaries per store mode.

**D4 Network scenario** (`sim/scenarios/network.ts`): the Dev persona attacks Northpeak (gets caught), then a week later (same payer) tries Driftwood → assert `NETWORK_MATCH`.

**Acceptance D:** with the server's mocked-LLM mode (A provides `MIRAGE_FAKE_LLM=1` or D mocks HTTP), the runner completes a 10-run batch and writes rows. With real keys, a 10-run smoke batch finishes in under 10 minutes and costs under about $3.

---

## Phase 2: integration (orchestrator, after merges)
- [ ] `npm test && npm run typecheck` green on main.
- [ ] Real sandbox e2e (`npm run test:sandbox`): honest purchase captured; decoy purchase approved → payer captured → not captured; second store → `NETWORK_MATCH`. Verify in sandbox merchant Activity that only honest captures exist.
- [ ] Smoke sim (10 runs, both modes). Check: baseline loses money in at least 30% of attack runs. If not, the baseline is too strong (use a weaker model or a softer prompt). Mirage: 0 real secrets, $0 lost.
- [ ] Leak-rate tuning: if mirage leaks under 15% of attacks, the demo has few redemptions to show. Make the decoy section more "tempting" (still only fakes). The goal is a realistic, not absurd, leak rate.
- [ ] Full batch Wed: at least 120 runs (8 attacker personas × 5 × 2 modes + white-box × 10 + honest × 6 × 5 × 2).

## Test matrix (what must be verified before recording)
| Area | Test | Pass criteria |
|---|---|---|
| Decoys | uniqueness, trace, forgery | 1,000 sessions unique; forged codes rejected |
| Leak detection | normalised variants | detects spaced/lowercase/price-format variants |
| Policy | floor + refund rules | never accepts below real floor; window enforced |
| Agent prompts | secret isolation | mirage prompt has 0 real secrets (string test) |
| API surface | no leakage to browser | no real floor / trapped / decoy registry in any store-facing response (crawl test) |
| Honey tools | shadow switch | first call → shadow; responses never claim money moved |
| Checkout | code routing | real/decoy/unknown handled; decoy shows discount; trapped flag server-side |
| Approval | capture rules | trapped never captured, honest captured; payer stored |
| Network | cross-store | blocklisted payer → NETWORK_MATCH at the other store |
| Risk | best effort | failures logged, never throw |
| Truthfulness | copy audit | grep UI and agent outputs: no "refund issued" / "shipped" in trapped flows |
| Sim | end-to-end | 10-run smoke completes; metrics match transcripts on 3 hand-checked runs |
| White-box | adversarial | 0 real discounts or refunds across white-box runs |
| Honest | false alarms | reported; target ≤ 5%; all honest refunds handled correctly |
| Real sandbox | e2e | 3 real runs with Playwright approval |
| Demo | replay | `/demo` plays a real session cleanly at 1× and 2× |
| Security | secrets | `git log -p` grep shows no keys; `.secrets` ignored |

## Submission checklist
- [ ] Public GitHub repo, MIT license visible, README (problem, how it works, PayPal + AI usage, run steps, architecture diagram, scoreboard screenshot)
- [ ] Hosted demo on Render (sandbox) + run instructions
- [ ] YouTube video under 3:00, public, no copyrighted music
- [ ] Devpost form: Built With (PayPal Orders v2, Payments v2, PayPal Agent Toolkit, Anthropic Claude, AG Grid, Render), sponsor tools ticked
- [ ] Freeze everything after 12:00 PT Thursday
