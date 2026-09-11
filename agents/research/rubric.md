# Research — pass rubric (v3)

Copied from `definition.md` §8, so the gate and the signed contract cannot drift. The definition is the
source; edit it there and re-copy. Who scores each row is in the last column: **machine** is
`src/lib/research/rubric.ts` over the pack alone; **bench** needs the run's record (steps, actuals, the
completion Event's report) and is scored by `scripts/research-bench.ts`; **test** is its own test;
**The product owner** is a human read.

## 8. Rubric (sign-off gate)
| # | Check | Pass | Scored by |
|---|---|---|---|
| 1 | Schema and derived confidence | every module parses; zero items asserted above the ceiling their evidence supports | machine |
| 2 | Coverage | every module present and `complete` on the non-thin briefs (no `insufficient` module, `partial: false`); floors met | machine |
| 3 | Provenance | ≤10% of claims demoted by the §7 check on the last attempt; five hand spot-checks agree | bench (the percentage), product owner (the spot-checks) |
| 4 | Buyer words | ≥60% of m06 phrases `notBuyer: false` with a role; vendor prose never presented as buyer words | machine |
| 5 | Recency | no `strong` m01 trigger, m02 vendor move or m04 seed-firm signal older than twelve months | machine |
| 6 | Domain spread | no module over three pages per domain (primary sources exempt); `moderate`+ claims span two domains; seed firms from ≥2 sources per kind of buyer | machine |
| 7 | Contradictions | ≥1 `purpose: contradiction` search per m03 kind of buyer in the steps; m17 written | bench |
| 8 | Insufficient path | brief C → `insufficient` with three widenings, no invented firms | machine (with `--expect-insufficient`) |
| 9 | Replay | a re-run after a simulated kill makes zero new search, fetch or module writes for stored keys; the first run's modules survive | test (`tests/worker/research.test.ts`) |
| 10 | Widening | brief D widens sensibly and repeats none of A's seed firms | machine (with `--prior-from`) |
| 11 | Cost and time | inside every rail (searches, pages, fetched text, model steps, minutes, spend); actuals recorded; estimate honest | bench |
| 12 | Depth against the bar | brief A read module by module against Signal's May insurance pack; brief E against the legal exemplar; nothing the campaign agent needs is missing | product owner |
| 13 | Plan-card view | `planCards(pack)` renders under the card schema; rep words only there | machine |

Five briefs: (A) Insights360, direct, UK insurance claims ops, 20 over 3 weeks · (B) Insights360, channel,
managed print dealers, Midlands, 15 over 4 weeks · (C) thin: vets in Orkney · (D) A re-run with
`priorRun.widenedBy = "region"` · (E) Insights360, direct, UK law firms with a client-facing line, 10–50 people,
25 over 4 weeks, one or two existing customers.

Sign-off requires zero `insufficient` modules on A, B, D and E. The v2 recordings of A, B and E in
`fixtures/research/` predate this contract; the rubric test skips them until they are re-recorded
in Step 6.
