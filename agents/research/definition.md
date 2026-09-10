# Relay agent definition — Research and Intelligence (v3, signed)
**v3 · SIGNED by the product owner 2026-09-09 (in session: "okay lets continue with the plan then with those changes. build it!") · supersedes v2 (signed 2026-09-08) · basis: `reviews/2026-09-09-audit-research-vs-signal.md`, `plans/2026-09-09-research-v3-plan.md`, independent plan review of 2026-09-09**
Contract: master §7.3 Research and intelligence (amended with this signature). Bar: Signal's May 2026 deep insurance pack and the fleet's Standard Campaign Pack Schema. Consumer: the campaign agent (a rebuild of Canvas, next), then lead gen, content, outreach through the briefs it writes. Screens: the plan cards are a **view** over this pack (§23.1c), not its shape.

What changed from v2, in one line: v2 made depth mechanical and shaped the output as plan cards; v3 keeps every mechanism and makes the output the whole intelligence layer, written module by module as the run goes, at the depth Signal's human pack reaches, so a campaign agent can decide from it without asking for more.

## 1. Job, in one line, and the boundary
Given the campaign card, the signed facts file, the product knowledge set and any prior packs, produce the complete intelligence pack for that market and buyer, every claim carrying its evidence and one of four confidence words, or say clearly that the evidence is not there and how to widen.

**What this agent does not do.** It reports what is true and where. It never decides which campaigns to run, never sequences or schedules anything, never allocates content or outreach to weeks or channels, never writes a brief for another agent, never names an individual as a target, and never claims anything about the product beyond the facts file and the shipped column of the knowledge set. Where §3 asks for candidates, angles or dated events, they are findings with evidence; the campaign agent chooses.

## 2. Inputs (schema `ResearchInput`)
```
brief:            { product, motion: "direct"|"channel", who, region: ISO-3166 alpha-2, howMany, weeks, channels[],
                    existingCustomers? }            // the eight campaign-start answers, the rep's words kept verbatim
factsVersion:     number                            // the signed facts file the run may claim from
knowledgeVersion: number                            // the product knowledge set the run may read
priorPackIds:     string[]                          // this org's earlier packs for the same product (read-only)
priorRun?:        { insufficient, widenedBy: "region"|"size"|"pain", note }   // on a "widen the brief" re-run
provenanceRerun?: { modules: string[], failures: [{ module, id, text, reason }] }   // set by the runtime, §7
```
Nothing else is asked of the rep. Hard filters (geography, size cap, sub-sectors in and out, other conditions) are **derived by the agent** in module m00 from `who` and `region`, and echoed verbatim in m08. `existingCustomers` is a hypothesis about what already converts: search for more like them and for their words; never name them in the pack; never claim anything on the strength of them.

## 3. Output (schema `ResearchPack`)
The pack is a fixed set of modules, every one required, written in order and **validated as each is written** (§5, §7). A module is:
```
Module = { body: Markdown, claims: Item[], ...structured fields per module, status: "complete"|"insufficient" }
Item   = { id, text, quote?, speaker?, role?, publishedAt?, accessedAt,
           evidence: { urls: Url[1..], primary: boolean, domains: string[] },
           confidence: "strong"|"moderate"|"weak"|"speculative", inferredFrom? }
Phrase = Item & { say, notThis?, notBuyer: boolean }
```
`body` is prose the campaign agent reads, at whatever length the market needs; **no ceiling**. `claims` are the checkable statements the body rests on; provenance (§7) runs on them. Structural floors are listed per module; a module under its floor is refused and re-asked once.

| Module | Holds | Floor |
|---|---|---|
| **m00 Steering note** | What the brief means: the regulatory or commercial spine, the displacement being sold against, what "ready now" looks like, what must not lead the messaging, the offer hook from the facts; the **hard filters** derived from the card; the prior packs read and what they claimed | hard filters present |
| **repSummary** | Five lines in rep words for the campaign card: who to reach, why now, what to say first, the biggest unknown, the size of the opportunity | exactly 5 lines; plain words |
| **execSummary** | The wedge, the ICP in a paragraph, the archetypes named, the competitive position, the product constraints every downstream agent must respect, a verdict on whether the market is worth the campaign | ≥3 claims |
| **m01 Market and company landscape** | Size in the units the sector uses; sub-segments with ICP fit `HIGH`/`MEDIUM`/`LOW`/`OUT` and why; regulatory and governance bodies; dated triggers from the last twelve months; activity metrics relevant to the product; what changes in the next six months | ≥4 sub-segments; ≥3 triggers; ≥5 claims |
| **m02 Competitive landscape** | Direct competitors with positioning and confirmed prices (gated ones marked); adjacent solutions and the do-nothing option; a pricing comparison table against the product; per-tier strengths and weaknesses; vendor moves in the last six months; where buyers discover tools | ≥3 competitors; table present |
| **m03 Persona intelligence** | 3–5 named archetypes (the one agreed cap), each a sector + size + situation; per archetype: organisation profile with size range; dominant pain with source; buyer roles with seniority (who signs, who champions, who runs it); an opening angle; deal economics from **live pricing facts only**, else marked `speculative` and said so | 3–5 archetypes, all fields |
| **m04 Targeting specification** | Per archetype: a filter recipe in lead gen's vocabulary (sector, size band, geography, regulatory exposure, tech-stack signals); a buying-trigger taxonomy table (signal, `HOT`/`WARM`, where to find it); list-building sources with URLs; ≥2 seed firms each with urgency signal, **size: confirmed / estimated with source / unknown**, and source, drawn from ≥2 different sources per archetype, labelled "validation sample, not the list"; the recipe carries exactly lead gen's six fields (`titles[]`, `excludeTitles[]`, `sizeBand`, `countries[]`, `industries[]`, `triggers[]`) and echoes the m00 hard filters | per archetype: recipe with the six fields, ≥3 triggers, ≥2 sources, ≥2 seed firms |
| **m05 Pains by archetype** | ≥4 pains per archetype, most acute first: mechanism, source, a verbatim quote with speaker, role and date where a buyer said it | ≥4 per archetype |
| **m06 Buyer words** | Per archetype the phrases buyers actually use with speaker and role, "say this / not this" pairs, vendor voices marked `notBuyer` | ≥3 phrases per archetype; ≥60% `notBuyer:false` with a role across the pack |
| **m07 Solution mapping** | Each pain → the shipped capability that answers it (from the knowledge set's shipped column), what must not be implied beside it; an **unmatched pains** table with roadmap status | every m05 pain mapped or listed unmatched |
| **m08 ICP definition** | Ideal company (firmographics), ideal buyer (roles, seniority, situation, what makes them ready), disqualifiers with reasons; the m00 hard filters echoed verbatim | all three; filters echoed |
| **m09 Messaging and positioning** | Brand constraints from the knowledge set; per archetype ≥5 ranked angles each with confidence and channel fit; a do/don't language table; verbatim phrases from primary sources that content and outreach may reuse; the sector's own vocabulary | per archetype: ≥5 angles, table, ≥3 phrases |
| **m10 Where buyers gather** | Trade press, events with dates, associations, communities, review sites; per archetype where different. A person appears only as the author of a cited source, never as someone to follow or target | ≥5 entries with URLs |
| **m11 Objections** | Per archetype the objections a buyer will raise, each answered only from the facts file and the shipped column, or marked "no grounded answer" | ≥3 per archetype |
| **m12 Contact rules** | How these buyers may lawfully be contacted in this region and sector (e.g. PECR for email, professional-body rules), anything that bars a channel, with sources | ≥1 rule per channel on the card |
| **m13 Dated events and deadlines** | Regulatory deadlines, publications, seasonal windows and events that fall inside or near the campaign weeks, **as dated facts with no allocation** | ≥3 dated entries or an explicit "none found" |
| **m14 Changes since the last pack** | When `priorPackIds` is non-empty: new triggers, dropped or merged archetypes, price moves, contradictions with the earlier pack | present when a prior pack exists |
| **m15 Proof the rep may use** | The customer references, figures and claims the facts file allows in this sector, and what it does not allow | ≥1 entry, every one a live fact id |
| **m16 Campaign candidates** | The campaigns this research supports, each: archetype, lead angle, channel fit, why now, the seed firms that fit, what would make it the wrong call. Findings, not a plan | ≥1 per archetype with ≥3 pains |
| **m17 Contradictions** | Every finding that argues against the pitch, with source, and what it means for the messaging; where two sources disagree, both as `{a, b}` | ≥1 or an explicit "none found after search" |
| **m18 Unknowns** | Typed `not-found`/`confirmed-absent`/`unreadable`/`conflicting`/`out-of-budget`, each with why it matters, what to ask on the first call, and `queriesTried[]` on every `not-found` | ≥1 |
| **m19 Sources** | Every external source with URL and access date; the knowledge articles and facts version used; prior packs cited | complete |
| **insufficient?** | When the brief is thin (§5 stop rule): what was found, and exactly three widenings of kinds region, size, pain. No invented firms | exactly 3 widenings |

**Rules enforced at validation, not by the prompt** (§7 has the mechanics):
- `confidence` is derived, never asserted: `strong` needs a primary source or three URLs across two domains; `moderate` two URLs across two domains; `weak` one; `speculative` zero and must name `inferredFrom`. Asserted above the ceiling → refused.
- **Twelve-month demotion applies to triggers (m01), vendor moves (m02), seed-firm signals (m04) and m13 entries**, which drop to `weak` when older than twelve months. Standing regulation, statistics and pricing are dated but not demoted; `publishedAt` still shows.
- **Three pages per domain per module**, except **primary sources**: a regulator, an official statistics body, a court or ombudsman, a trade body's own register, and the product knowledge set are exempt, because a fourth page from the regulator in the regulatory module is truth, not padding. A fourth page from any other domain in one module is refused. Pages may be cited by any number of claims.
- **Every `Item` or `Phrase` anywhere in a module is a claim for §7** (pains, phrases, seed-firm signals, triggers included); `claims[]` holds the statements the body rests on that have no field of their own.
- Deal economics figures must cite a `live` pricing fact id, or the field is `speculative` and the body says pricing is not yet confirmed.
- `m07` may map only to capabilities the knowledge set marks shipped. `m15` and `m11` answers cite live fact ids only.
- `repSummary` and the plan-card view pass the plain-words check. Module bodies do not carry it; the campaign agent reads them.
- Ids are stable slugs, unique across the pack. Dates are `YYYY-MM-DD`, `YYYY-MM` or `YYYY`; URLs absolute.
- A module refused twice is stored `status: "insufficient"` with its issues; the run continues. Sign-off (§8) requires none on the non-thin briefs.

**Derived views (the pack is the contract; these are read from it, never written by the agent):**
- `planCards(pack)` renders the campaign page's cards (§23.1c) from the pack: summary from `repSummary`, kinds of buyer from m03/m05/m06, the hook (below), seed firms from m04, what could not be found from m18, contradictions from m17, widenings from `insufficient`.
- **Lead gen's recipe** (leadgen v2 §2) is m04's recipe for the chosen archetype, six fields exactly, hard filters applied.
- **Outreach's hook** (outreach v2 §2) is derived per chosen archetype: `text` = that archetype's m03 opening angle; `whyNow` = its strongest dated trigger from m01 or m13; `answeredBy` = the live fact ids m07 maps to that archetype's dominant pain.
- **Who chooses the archetype** in slice 1, before the campaign agent exists: the top-ranked m16 candidate is chosen by default and shown on the card; the rep may change it there. When the campaign agent lands it chooses. *(Taken on signature, 2026-09-09.)*

## 4. Tools (read-only; nothing spends money outside the run's own budget)
| Tool | Contract | Runtime behaviour |
|---|---|---|
| `facts()` | the signed facts file at `factsVersion` | first call of every run |
| `knowledge(article)` | one article of the product knowledge set at `knowledgeVersion` (overview, roadmap, architecture, integrations, icp, competitors, brand-voice, decisions, known-issues): a **scrubbed copy shipped in the repository**, no fleet names, no VPS paths, versioned and hashed like the facts file | allowlisted; the roadmap's shipped column is the only source for m07 |
| `priorPacks()` | this org's earlier packs for the product, by id, module bodies included | advisory: a prior claim enters the pack only with a fresh URL found this run; m14 is written against them |
| `search(query, {region, recencyMonths?, purpose})` | Tavily, top 8 `{title,url,snippet,publishedAt?}`; `purpose` ∈ survey/locate/contradiction | toolKey = sha(query, region, recency); replay on retry; `purpose` is recorded for §8 row 7 and not sent to the provider |
| `fetch(url)` | Firecrawl scrape → markdown, main content, 12k cap; retry via Tavily extract; second failure returns `unreadable` and the runtime writes the unknown | toolKey = sha(url); injection-scanned before the model sees it; every stored page is the corpus §7 checks against |
| `writeModule(module, content)` | validates `content` against that module's schema; accepted → stored on the run and `{accepted:true}`; refused → `{accepted:false, issues[]}`; a second refusal of the same module is stored `insufficient` | toolKey = sha(module, sha(content)); the pack is assembled from the latest accepted version of each module across every run of the job, so a retry after a kill keeps what was written |
No browser, no email, no CRM, no Lusha, no file system, no sub-agents (v3; an amendment may add sub-agents once the ledger proves their turns).

## 5. Method (the prompt's spine)
1. **Read before searching.** `facts()`, every `knowledge()` article, `priorPacks()`. Write **m00** and call `writeModule` for it before any search: the spine, the displacement, "ready now", what must not lead, the hard filters, and what the prior packs claimed as hypotheses to verify.
2. **Wave 1, survey** (`purpose: survey`): two-to-three-word queries that map the landscape; read titles and snippets; fetch nothing yet. Candidate archetypes as situations, not titles. Write **m01** when the landscape holds.
3. **Wave 2, locate and read** (`purpose: locate`): specific queries; fetch the pages worth reading in full; buyers' own words from forums, reviews, job adverts, trade-press quotes with a name and role, regulator complaints, earnings calls; competitor pages and price lists. Write **m02**, **m03**, **m05**, **m06**, **m04** as each holds. Stop a line when two or three sources agree or new queries return the same sources; never repeat a query.
4. **Wave 3, contradictions** (`purpose: contradiction`): at least one query per archetype for the opposite claim, for the incumbent, for the do-nothing option. Write **m17**.
5. **Write the rest** from what is held: **m07** against the shipped column, **m08**, **m09**, **m10**, **m11**, **m12**, **m13**, **m14** if a prior pack exists, **m15**, **m16**, **m18**, **m19**, **execSummary**, **repSummary**. Each module as soon as it is ready; a refusal comes back with issues, fix and rewrite once.
6. **Channel motion** leads with partner economics, portfolio fit and margin; direct with buyer pain.
7. **Stop rule.** After wave 2, any archetype with fewer than three sourced pains, or fewer than two seed firms for any archetype, and budget still unspent → search more. With the same result and budget spent, or a brief that is thin on its face → `insufficient` with what was found and exactly three widenings. No padding, no invented firms.
8. **Before finishing, read the budget line.** If most searches and pages are unspent and a floor is unmet, the run is not done.

## 6. Rails (safety, not scope)
One depth. The budget is a set of rails an order above what a full pack needs; nothing trims scope to stay inside them.
| Rail | Value |
|---|---|
| searches | 120 |
| pages fetched | 60 |
| fetched text | 400,000 characters |
| model steps | 200 |
| wall clock | 90 minutes |
| spend | $50 |
At **70% of any rail** the next tool result carries a runtime checkpoint; the agent states what it still lacks and either finishes, or says which modules will be partial. A rail reached ends the run: the modules already accepted are stored, the pack is marked `partial` with the missing modules listed, and the job **completes**. The campaign agent sees a partial pack, not a failed job. The orchestrator's research job timeout and the queue's lease and reaper must cover the 90-minute rail (timeout 100 minutes; §7.3 amendment). *Note, not a term: expected cost on Opus 5 at high effort about $8 a run, range $6–14, and 20–45 minutes; the bench records actuals.*

## 7. Validation and provenance (mechanical, per module)
- **On write**: schema, floors, derived confidence, twelve-month demotion, per-module domain cap, live-fact rules, id uniqueness, formats. Refused → issues back to the model, one rewrite; second refusal → stored `insufficient`.
- **Provenance, after the run, per module**: for every `Item` in `claims`, at least one `evidence.urls` entry must be in the run's stored page corpus (or a search snippet), and that text must contain the cited number, a six-word span of the `quote`, or two of the item's three most distinctive content words. Failures drop to `speculative` with `inferredFrom: "provenance: <reason>"` and are listed in the run report. A module with more than 20% failing claims is **re-asked alone**, once, through a second attempt whose input names the module and the failures (`provenanceRerun`); every earlier tool call replays. A second failure leaves the module demoted and the pack completes.
- **The depth fixture.** Signal's May 2026 insurance pack, converted to the v3 shape, is the fixture every rule is proved against for bodies and claims: a rule that refuses it is wrong. It predates three Relay rules and is exempt from exactly those, each named in the fixture's manifest: the m04 shape floor (its Module 4 is the pre-2026-05-26 named-list shape), the m06 buyer-words ratio (its phrases are mostly adviser commentary), and the per-module domain cap only where the exempt primary-source rule above does not already cover it.
- **Ingest**: the assembled pack parses under the strict schema; the derived hook's `answeredBy`, m15 proof and m11 answers cite live fact ids only; stored on the campaign's research record with `factsVersion`, `knowledgeVersion`, hashes, cost, minutes, `partial`, and the provenance report.

## 8. Rubric (sign-off gate; the bench scores what a machine can)
| # | Check | Pass |
|---|---|---|
| 1 | Schema and derived confidence | every module parses; zero asserted-above-ceiling |
| 2 | Coverage | every module present and `complete` on the non-thin briefs; floors met |
| 3 | Provenance | ≤10% claims demoted; five hand spot-checks agree |
| 4 | Buyer words | ≥60% of m06 phrases `notBuyer:false` with a role; vendor prose never presented as buyer words |
| 5 | Recency | no `strong` dated claim older than twelve months |
| 6 | Domain spread | no module over the per-module cap; `moderate`+ claims span two domains; seed firms from ≥2 sources per archetype |
| 7 | Contradictions | ≥1 `purpose: contradiction` search per archetype in the steps; m17 written |
| 8 | Insufficient path | brief C → `insufficient` with three widenings, no invented firms |
| 9 | Replay | re-run after a simulated kill makes zero new search, fetch or module writes for stored keys; the first run's modules survive |
| 10 | Widening | brief D widens sensibly and repeats none of A's seed firms |
| 11 | Cost and time | inside the rails; actuals recorded; estimate honest |
| 12 | Depth against the bar | brief A read module by module against Signal's May insurance pack by the product owner; brief E against the legal exemplar; nothing the campaign agent needs is missing |
| 13 | Plan-card view | `planCards(pack)` renders on the bench; rep words only there |

Five briefs: (A) Insights360, direct, UK insurance claims ops, 20 over 3 weeks · (B) Insights360, channel, managed print dealers, Midlands, 15 over 4 weeks · (C) thin: vets in Orkney · (D) A re-run with `priorRun.widenedBy = "region"` · (E) Insights360, direct, UK law firms with a client-facing line, 10–50 people, 25 over 4 weeks, one or two existing customers.

## 9. Deliberately not here
Competitors' customers by name as targets; individuals; any decision about which campaign to run, in what order, on which week or channel; briefs for other agents; per-person lookups (outreach, at draft time); anything that writes outside the run's own record.

## 10. Amendment notes carried from v2 and today
1. Facts-only claims allowed as `strong` with source `facts://i360.<id>` and `primary: true`. 2. ISO codes internally, country names on screen. 3. Partial dates accepted (2026-09-09). 4. `existingCustomers` is the eighth and last campaign-start question (2026-09-09). 5. Sub-agents out of v3 pending a ledger test (2026-09-09). 6. **Depth fixture, a fourth exemption** (§7; product owner, 2026-09-10): fields v3 added that the May pack predates — m02 `doNothing`, m09 angle `confidence` and `channelFit`, m18 `queriesTried` on a `not-found` unknown, m19 `factsVersion`. They stay v3 rules for every run; the fixture is exempt from them by name in its manifest. 7. **`onlyModules`** (§2; product owner, 2026-09-10): a runtime input beside `provenanceRerun`, set only by the bench (`--modules`), so a run writes m00 and the named modules and nothing else; a job never sets it. 8. Dated-event dates (m13) take the §3 date formats (2026-09-10).

---
**Signature block.** Signed by the product owner 2026-09-09, with the two flagged recommendations taken: the primary-source carve-out on the per-module domain cap, and the top-ranked campaign candidate as the slice-1 default archetype, changeable on the card. On signature this file is renamed `research.v3.signed.md`, copied verbatim to `agents/research/definition.md`, and the master doc amendment in `plans/2026-09-09-master-doc-amendment-research-v3.md` is applied.
