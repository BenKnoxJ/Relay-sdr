# Relay agent definition — Research (v2, signed)
**v2 · SIGNED by Benny-san 2026-09-08 · supersedes v1 · audit: `reviews/2026-09-08-review-signal-depth.md`**
Contract: master §7.3 Research. Screens: plan cards and unknowns card (§23.1c). Spike: Task 12. Bench: Task 6b.

What changed from v1, in one line: v1 fixed the shape; v2 makes depth mechanical. Confidence is derived from evidence rather than asserted, every item is dated and quoted, prior knowledge is read but never trusted without a fresh URL, fetches cascade and failures become unknowns, provenance is checked by the runtime before ingest, and the budget scales with the brief.

## 1. Job, in one line
Given a campaign brief, a product facts file and the motion, produce the structured pack that outreach opens on and lead gen searches with, or say clearly that the evidence is not there and how to widen.

## 2. Inputs (schema `ResearchInput`)
```
brief:     { product, motion: "direct"|"channel", who, region: ISO-3166 alpha-2, howMany, weeks, channels[] }
facts:     ProductFacts                      // the signed facts file; the only source of product claims
priorRun?: { insufficient, widenedBy: "region"|"size"|"pain", note }   // on a "widen the brief" re-run
breadth:   "narrow"|"standard"|"wide"       // set by the runtime from the brief (see §6)
```

## 3. Output (schema `ResearchPack`)
```
summary:        string[3]
archetypes:     Archetype[2..4]   { id, name, situation, pains: Item[3..8], language: Phrase[] }
hook:           { id, text, whyNow: Item, answeredBy: FactId[] }         // answeredBy must be live facts
seedFirms:      Firm[4..10]       { id, name, domain?, region, signal: Item }
recipe:         { titles[], sizeBand:{min,max}, countries[], industries[], triggers[] }   // Lusha vocabulary
unknowns:       Unknown[1..]      { id, text, kind: "not-found"|"confirmed-absent"|"unreadable", queriesTried[] }
contradictions: Contradiction[]   { id, text, a: Item, b: Item }         // sources disagree; shown as such
insufficient?:  { found: Item[], widenings: [Widening, Widening, Widening] }

Item = { id, text, quote?, speaker?, role?, publishedAt?, accessedAt,
         evidence: { urls: Url[1..], primary: boolean, domains: string[] },
         confidence: "strong"|"moderate"|"weak"|"speculative" }
Phrase = Item & { say: string, notThis?: string, notBuyer: boolean }    // vendor or consultant wording is flagged, never presented as buyer words
```
**Schema rules (enforced at ingest, not by the prompt):**
- `confidence` is **derived**, never asserted: `strong` needs a primary source or three URLs across two domains; `moderate` needs two URLs across two distinct domains; `weak` one URL; `speculative` zero URLs and must name what it is inferred from. An asserted word above the ceiling is rejected.
- `whyNow` and every seed-firm `signal` with `publishedAt` older than 12 months drop to `weak` automatically.
- At most 3 sources per domain across the pack; the domain cap is a validation error, not advice.
- `unknowns` never empty. `hook.answeredBy` must reference `live` facts only.
- `assertPlainWords` on every string: no agent names, "module", "ICP", "persona", downstream instructions. Ids are stable slugs.

## 4. Tools (read-only; nothing spends)
| Tool | Contract | Runtime behaviour |
|---|---|---|
| `facts()` | the signed facts file | first call of every run |
| `priorKnowledge(product)` | the wiki's existing ICP, competitor and overview articles for the product, as text | **advisory only**: a prior claim may enter the pack only with a fresh URL found this run |
| `search(query, {region, recencyMonths?})` | Tavily, top 8 `{title,url,snippet,publishedAt?}` | toolKey = sha(query, region, recency); replay on retry |
| `fetch(url)` | Firecrawl scrape → markdown, main content, 12k cap; on failure the runtime retries with Tavily extract; on a second failure it writes `unknowns[kind=unreadable]` itself | toolKey = sha(url); fetched text is **injection-scanned** (instruction-shaped lines stripped and logged) before the model sees it; every stored page forms the corpus provenance is checked against |
No browser, no email, no CRM, no Lusha.

## 5. Method (the prompt's spine)
1. **Facts, then prior knowledge.** Read `facts()`. Read `priorKnowledge()` and write down what it claims as *hypotheses to verify*, not findings.
2. **Wave 1, the market and who buys** (narrow 4, standard 8, wide 12 searches): survey, identify candidate archetypes as situations (sector + size + situation), not titles.
3. **Wave 2, pains in buyers' own words**: forums, reviews, job adverts, trade press letters, regulator complaints, earnings calls. Capture `quote`, `speaker`, `role`, `publishedAt`. A vendor or consultant saying it is evidence of the *topic*, not of the buyer's words: keep it, set `notBuyer: true`. Stop a wave early when three independent sources agree.
4. **Wave 3, why now and named firms**: signals from the last 12 months; four to ten seed firms with the signal and its URL. **Then the contradiction search**: one query per archetype looking for the opposite claim; anything found goes to `contradictions`, never silently dropped.
5. **Channel motion** leads with partner economics, portfolio fit and margin; direct leads with buyer pain.
6. **Unknowns as you go**: every query with nothing useful becomes an `unknown` with `queriesTried`; the runtime adds `unreadable` ones from fetch failures.
7. **Stop rule** (unchanged): after wave 2, any archetype with fewer than three sourced pains, or fewer than four seed firms overall, → `insufficient` with what was found and exactly three widenings (region, size, name-the-pain). No padding, no invented firms.
8. **Rep words only**, written for the plan cards.

## 6. Budget, scaled by breadth (runtime-set, not model-chosen)
| breadth | inferred from | searches | fetches | model steps | minutes |
|---|---|---|---|---|---|
| narrow | one sector, one region, ≤20 people | 20 | 12 | 20 | 8 |
| standard | one sector, national, or channel motion | 40 | 25 | 30 | 15 |
| wide | multi-sector or "widen the brief" re-run | 60 | 35 | 40 | 20 |
At **70% of any cap** the runtime injects a re-plan step: the agent must state what it still lacks and either finish or narrow. Hard caps abort the run; the agent must emit its best pack or `insufficient` before the last step. Target cost under $1.50 (narrow) to $3 (wide); the bench records actuals.

## 7. Provenance check (mechanical, before ingest)
For every `Item`: at least one of its `evidence.urls` must be in the run's stored page corpus, and that page or its search snippet must contain either the cited number, or a six-word span of the `quote`, or (for paraphrases) two of the item's three most distinctive content words. Items that fail are dropped to `speculative` and listed in the run's report; a pack with more than 20% failures is rejected and re-run once with the failures named in the prompt.

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

## 9. Deliberately not here
Competitor pricing tables, solution mapping, full ICP definitions (Signal's human pack keeps those). Per-person lookups (outreach, at draft time). Anything that writes.

## 10. Resolved from v1's open questions (recommendations taken unless you say otherwise)
1. `priorKnowledge()` in, advisory only, fresh-URL rule. 2. Facts-only claims allowed as `strong` with source `facts://i360.<id>` and `primary: true`. 3. ISO codes internally, country names on screen.
