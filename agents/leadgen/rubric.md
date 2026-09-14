# Leadgen — pass rubric

Copied from `definition.md` §5, so the gate and the signed contract cannot drift. The definition is the
source; edit it there and re-copy.

## 5. Rubric (sign-off gate; recorded-fixture mock plus a live smoke)
| # | Check | Pass |
|---|---|---|
| 1 | Translation | every term in the three fixture packs maps via facet ids; an invented term halts naming it; an excluded title never appears |
| 2 | Estimate first | the estimate line exists before the first search call (mock call log order); over-cap halts with no search |
| 3 | Holds | fixture with one of every hold reason, including open deal and suppressed: none appear; counts correct; manual add of a held person is refused with the reason |
| 4 | Ranking | deterministic across three runs; per-company cap never exceeded; `whyPicked` matches fired parts |
| 5 | Spend | zero reveal calls before confirm; after confirm calls = chosen with `hasEmail` minus re-attached; ledger rows equal Lusha's returned charges; a throwing call leaves no ledger row |
| 6 | Idempotent reveal | repeated confirm after a simulated kill reveals nobody twice, no duplicate ledger rows |
| 7 | Never twice | a person revealed in campaign 1 (with or without email) is re-attached or suppressed in campaign 2, never bought |
| 8 | Wrong person | a reveal whose name differs from the preview is held, ledgered, suppressed |
| 9 | Paging | stops at `maxPages`; "N of M found" appears; one more page per press |
| 10 | 429 | mock 429 twice then 200: succeeds with backoff; three 429s → `provider_busy`, not needsYou |
| 11 | Words | `assertPlainWords` on `whyPicked`, reasons and messages |
| 12 | On screen | Your people before and after reveal from fixtures on the bench, eyeballed |
| 13 | Live smoke (five cases, throwaway campaign, `INTEGRATIONS=live`) | page cost at size 40 and 100 recorded; `values` envelope handled; a no-email reveal suppresses; a wrong-person reveal held; a 429 retried. Ledger equals Lusha's usage endpoint before and after |

## v2.1 amendments to this rubric (signed 2026-09-14)

Copied from `definition.md` (v2.1 §14), which amends the table above. The bench checklist parses the table only; the v2.1 rows join it when lead gen is built.

## 14. Rubric changes
- Row 2: the Confirm-screen cap is shown and the balance snapshot is read server-side before any search.
- Row 5: the invariant holds on every request in the mock call log, and unknown outcomes stay reserved.
- Row 9: paging stops at `howMany` or at the invariant; partial results are shown as People found X of N.

New rows:
- only `LeadGenHandoffV1` reaches lead gen, and no import from `agents/research/**`;
- lead gen uses the handoff's buyer group and never reads `sourceRank`;
- no fallback to another group;
- reuse: a candidate matching a usable owned Person makes zero reveal calls and zero credits, and is still ranked and capped;
- a reveal returning a known email canonicalises to the existing Person;
- `no_email`, `invalid_id` and `wrong_person` records are never re-bought, but never block the same human through another record;
- email-based holds never run before reveal;
- translation never widens, and the rep never sees provider ids;
- campaign-only holds never write a suppression.
