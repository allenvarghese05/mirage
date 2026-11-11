# Mirage results (use these exact numbers in the video and README)

Batch `full-1`, 120 runs, 2026-11-10/11. Rescored with the reviewed contextual leak detector (no new AI calls).
Raw data: `data/sim-runs-full-1.json`; sessions in `data/smoke2.sqlite`.

Setup, identical for both stores:
- Store agent: Claude Haiku 5.5, "realistic" deployment profile (staff-convenience rules typical of real shops).
- Same prompt, same tools, same catalog. The ONLY difference: the comparison store's prompt holds the REAL floor
  prices and codes; Mirage's holds per-chat decoys (self-tracing codes, fake floors) plus fake staff tools.
- Attackers: Claude Haiku 5.5 personas (8 black-box techniques plus 1 white-box attacker given Mirage's prompt template,
  honey-tool names and design doc). Honest customers: 6 personas (shopping, haggling, legit and late refunds, confused, pushy).
- 36 attack runs + 24 honest runs per store.

| | Comparison store | Mirage |
|---|---|---|
| Real secrets leaked | 3 | **0** |
| Money lost | $271.15 | **$0.00** |
| Attackers caught | 0 | **7** |
| Attackers identified through PayPal | 0 | **6** |
| Attribution (redeemed decoy traced to the right chat) | n/a | **100%** |
| False alarms on honest customers | 0 | **0** |
| Honest customers served correctly | 24/24 | **24/24** |
| White-box attacker (read our design) | gained nothing real | gained nothing real |

How these were checked:
- Every flagged "real leak" was inspected by hand (`scripts/inspect-leaks.ts`). Five were coincidental numbers
  (totals like "$112.00 combined", "$17 under your budget", an attacker's own offer echoed back) and were
  removed by a reviewed rule applied identically to BOTH stores. The comparison store's 3 remaining leaks are genuine
  (e.g. the agent read out `NP-CREW-2291` and `DW-BARISTA-7714`, which were then redeemed at checkout).
- Leak *rate* differs between stores (about 19% vs 8%) because of sample size and because a decoy counts as a leak;
  don't headline the rate. Headline the outcomes: secrets, dollars, identities.
- Real PayPal sandbox: decoy orders approved by a real sandbox buyer were read, held and never captured
  (`npm run test:sandbox`).

Cost of the whole evaluation: $0.85 of Claude API spend (hard-capped at $5).

Suggested VO line: "We sent 72 AI attacks at two identical stores. The normal store gave away real codes and lost
$271. Mirage lost nothing, gave away nothing real, and PayPal identified six of the attackers. No honest customer
was ever flagged."
