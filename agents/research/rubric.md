# Research — pass rubric

Copied from `definition.md` §8, so the gate and the signed contract cannot drift. The definition is the
source; edit it there and re-copy.

## 8. Rubric (sign-off gate; Task 12 uses the same)
| # | Check | Pass |
|---|---|---|
| 1 | Schema and derived confidence | validates; zero asserted-above-ceiling errors |
| 2 | Coverage | ≥2 archetypes with ≥3 pains; hook with dated whyNow and live `answeredBy`; ≥4 seed firms with dated signals; recipe; unknowns non-empty |
| 3 | Provenance | §7 check passes with ≤10% items demoted; five hand spot-checks agree |
| 4 | Buyer words | ≥60% of language phrases have `notBuyer: false` with a speaker role; vendor prose never presented as buyer words |
| 5 | Recency | no `strong` whyNow or seed signal older than 12 months |
| 6 | Domain spread | no domain over the cap; `moderate`+ items span two domains |
| 7 | Contradictions | at least one contradiction query per archetype ran (visible in steps); findings, if any, are in `contradictions` |
| 8 | Insufficient path | brief C → `insufficient` with three widenings, no invented firms |
| 9 | Replay | re-run after a simulated kill makes zero new search or fetch calls for stored steps |
| 10 | Widening | brief A re-run with `priorRun` widens sensibly and does not repeat A's seed firms |
| 11 | Cost and time | within §6; actuals recorded |
| 12 | On screen | rendered in the plan cards on the bench and eyeballed by Benny-san |

Four briefs: (A) Insights360, direct, UK insurance claims ops, 20 over 3 weeks · (B) Insights360, channel, managed print dealers, Midlands, 15 over 4 weeks · (C) thin: vets in Orkney · (D) A re-run with `priorRun.widenedBy = "region"`.
