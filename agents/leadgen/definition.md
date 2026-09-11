# Relay agent definition — Lead gen (v2, signed)
**v2 · SIGNED by Benny-san 2026-09-08 · supersedes v1 · audit: `reviews/2026-09-08-review-leadgen-depth.md`**
Contract: master §7.3 Lead gen, §13. Screen: Your people (§23.1e). Carries Sales360's ledger, holds and re-attach mechanics and Pitch's search discipline as they stand.

What changed from v1: the preview is not free (one search credit per page, cost by page size unverified); nothing is ever bought twice thanks to a suppression row; open deals and "already being contacted" are decided before the credit, not after; every reveal is checked against its preview; the estimate covers pages plus reveals and is shown before the first search.

## 0. Shape
Zero model calls. Deterministic code over a Lusha adapter and Zoho reads, with a mock that records calls and a five-case live smoke before any rep sees it.

## 1. Job, in one line
Turn the targeting recipe into exactly N ranked people, spending nothing beyond the estimate the rep saw, and never buying the same person twice anywhere in the org.

## 2. Inputs
```
recipe:    { titles[], excludeTitles[], sizeBand, countries:["GB"], industries[], triggers[] }   // Lusha vocabulary from the pack
howMany:   N (10|20|30|50)
seedFirms: Firm[]
holds:     built by code, org-level: customer domains and open-deal domains (Zoho, cached per domain per day), DNC emails and domains, opted-out, being contacted (one exported `isBeingContacted(person)` shared with Approve), already revealed (Person) and suppressed (Suppression by lushaId)
caps:      { orgCreditsRemaining, perCompanyMax: 3, maxPages: 3 }
```

## 3. Outputs
Before reveal: `Pick{ chosen: Person[N], spare: Person[], estimate: { pages, reveals, credits, remainingAfter }, found: {n, ofM}, holdsApplied: {reason, count}[] }`
After reveal: `Revealed{ people, ledger, held: {personId, reason}[] }` with `status: verified|held|needs_you|bounced`.
Preview fields only on `Person` (name, title, company, domain, country, city, linkedinUrl, hasEmail) plus `score`, `whyPicked`, `rank`, `companyKey`. Nothing else exists at preview time.

## 4. Steps (all code)
1. **Translate** the recipe through Lusha's `filters()` facet ids (titles, size bands, industries, countries); a term with no facet halts with `unmappable: [term]` and nothing is searched. Title matching uses the recipe's `excludeTitles` list (Pitch's block-list pattern).
2. **Estimate before the first search**: pages needed (from N, per-company cap and an assumed 60% hold rate, later corrected from real pages) plus reveals (N); if pages or reveals exceed `orgCreditsRemaining`, halt with `over_cap` and the numbers. The rep sees this line on Your people before anything runs.
3. **Search** one page at a time; one search credit per page, ledgered from the provider's response. Stop when `chosen` is full or `maxPages` reached; then say "N of M found" and page again only on the rep's say (the "look further" button, one page per press).
4. **Holds on the preview** before scoring, via one pure function: customer domain, open-deal domain (its own reason word), DNC, opted out, `isBeingContacted`, already revealed (Person in this org), suppressed (Suppression by lushaId). Held people never appear; counts per reason go to the header. Manual add runs the same function.
5. **Zoho lookups batched per page** (one query per page of domains), with bounded retry and backoff on 429 for both Zoho and Lusha (3 tries: 1 s, 5 s, 15 s), then halt with `provider_busy` (not a failure for "failed twice").
6. **Score**, fixed weights: exact title 3, related title 1, seed-firm match 2, `hasEmail` 2, sector 1; per-company cap enforced during selection; tie-break by company diversity.
7. **Pick** top N as `chosen`; **every unheld preview beyond N is the spare pool** (not a fixed N/2), hidden. "Why picked" templated from the fired parts in rep words.
8. **On confirm, reveal** chosen with `hasEmail`, batched ten per request, idempotent on `campaignId:reveal:briefVersion:batch`; ledger row per person from Lusha's returned charge, under the month lock (Sales360's claim-lock-reconcile pattern: claim, overwrite with provider's charge, delete if the call throws). Already-revealed people anywhere in the org re-attach for zero credits.
9. **Verify each revealed contact against its preview**: name and domain must match; a mismatch is `held(wrong_person)`, ledgered, logged as provider fault, and a Suppression row is written so the id is never bought again.
10. **Suppression rows** are also written on: reveal returned no email, invalid id, and the rep's swap reason "know them already". Dedupe checks Person **and** Suppression.
11. **Grade**: below B → `held(below_b)`; Phase 1 leaves it terminal, slice 1 adds the verification provider.
12. **Swap**: record the reason (wrong title, wrong company, know them already, other), promote the top spare; "Find more" = one more page on the rep's press. **Add someone you know** runs step 4's hold function, no special path.
13. **Purge**: unrevealed previews deleted by the retention job at 30 days; Suppression rows are not purged.

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

## 6. Contract amendments this implies (for the master, on signing)
- §7.3 and §23.1e: "free preview" → "PII-free preview, one search credit per page"; §13 already says one per page.
- §25: add `Suppression.lushaId` and reasons `no_email|wrong_person|invalid_id|known`; add open-deal to the holds list.
- §23.1e header line shows the estimate (pages + reveals) before the first search.

## 7. Deliberately not here
Any model call. Phone reveal. Per-person company size or industry. The Zoho lead upsert (outreach, first send). The verification provider (slice 1).

## 8. Resolved from v1's open questions
1. Spare pool = every unheld preview beyond N. 2. Five score weights as listed; no signal not visible on the preview. 3. `isBeingContacted` kept and shared with Approve, empty in a one-rep pilot.

## 9. Amendment notes
1. **`recipe.locations`** (product owner 2026-09-11, with research v3.2 note 28; a contract correction found by testing): the targeting recipe gains one optional field, `locations[]`, the sub-national place names (e.g. "Orkney") that the rep's locked scope names. Research carries a supplied place through to it and may not widen it. Step 1 translates each location through Lusha's location filter like any other term. A location with no facet halts with `unmappable: [term]` and nothing is searched: lead gen never drops a location to widen a search.
