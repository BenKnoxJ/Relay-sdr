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


# Relay agent definition — Lead gen (v2.1, signed)
**v2.1 · SIGNED by the product owner 2026-09-14 · amends `leadgen.v2.signed.md` (and its note 1); where the two differ, v2.1 wins**
Inputs to this amendment: Lead Gen audit of `main` 585f444 (2026-09-14), product-owner decisions of 2026-09-14 (three rounds; the third approves the customer hold as best-effort positive-only, open deal deferred, the lawful-basis record shape, partial success, the two gates, the configurable cap with worst-case reservation, provider translation, and the zero-spend sequence in principle), public Lusha docs (not a live call). Research v3.2 is frozen and unchanged by this amendment.

Everything in v2 stands unless a section below replaces it. Provider facts marked **UNKNOWN** are not signed as fact.

## 0. Shape (unchanged in spirit)
Zero model calls. Deterministic code over a Lusha adapter and the existing Zoho adapter. A call-logging mock is the default. Nothing reaches a rep before the zero-spend metadata check (§12) and the paid live smoke (§13).

## 1. Job
From one frozen buyer group, find up to `howMany` eligible candidates within the search spend the rep approved at Confirm. Then, only on a second explicit approval, reveal their emails and stop at **People ready**. **Relay does not intentionally pay again for usable contact data it already owns** (§9). Never widen required scope.

## 2. Flow and gates (replaces v2 §4.2–4.3, 4.8 and orchestrator §5 rows "Confirm plan" and "Reveal")
Confirm plan (gate 1: search spend) → Finding people → People found → Reveal emails (gate 2: reveal spend) → People ready.
No Outreach or draft job is enqueued. People ready is terminal for this slice.

## 3. Input: `LeadGenHandoffV1` (replaces v2 §2)
Lead gen's only input is the handoff that Confirm freezes into the `campaign.confirmed` Event. Lead gen code never imports Research's module schemas or names (m03/m04/m16 …). An adapter at the campaign boundary (`src/lib/campaigns/`) builds it, from Research's signed derived views and the existing campaign selectors.

```ts
type LeadGenHandoffV1 = {
  version: 1;
  campaign: { id: string; orgId: string; ownerUserId: string; briefVersion: number; confirmRequestId: string };
  provenance: {
    researchJobId: string;
    researchEventId: string;            // the research.completed Event: append-only, so it is the pack's identity
    outcome: "complete" | "partial";
  };
  buyerGroup: { id: string; name: string; sourceRank: number };   // the group confirmed for this run; sourceRank is provenance only
  targeting: {                          // Research's signed lead-gen recipe for that group, copied verbatim
    titles: string[]; excludeTitles: string[];
    sizeBand: { min: number; max: number };
    countries: string[];                // ISO-3166 alpha-2, any, never widened
    locations: string[];                // may be empty; never dropped
    industries: string[];
    triggers: string[];                 // context only (§5): never a provider filter, never a halt
  };
  places: { name: string; aliases: string[] }[];       // brief.scope.places, for location aliases
  exclusions: {
    firms: { name: string; domain?: string }[];        // brief.scope.excludeFirms
    roles: string[];                                   // brief.scope.roles.exclude (local title guard)
    orgTypes: string[];                                // brief.scope.excludeOrgTypes (guards industry resolution)
  };
  seedFirms: { name: string; domain?: string; country: string }[];   // this group's only
  howMany: 10 | 20 | 30 | 50;
  perCompanyMax: 3;
  spend: {
    searchCreditCap: number;           // shown and approved at Confirm; default is configuration, TBD (§6)
    balanceSnapshot: { remaining: number; used?: number; total?: number; readAt: string };  // server-side, at Confirm
    pricingAssumptions: string;        // id of the documented/verified pricing model used by §6
  };
  lawfulBasis: { text: string; confirmedByUserId: string; confirmedAt: string; briefVersion: number };
};
```

Buyer-group semantics:
- Lead gen uses exactly the buyer group frozen in the handoff. It never selects, ranks or substitutes a group, and never reads `sourceRank` to decide anything.
- `sourceRank` records where the group stood in Research's ranking when it was confirmed. It is provenance only.

Adapter rules (H1 selection, at the campaign boundary, not in lead gen):
- The adapter chooses the top-ranked campaign candidate (`topCandidate`) and writes it with `sourceRank: 1`.
- The fallback in `chosenArchetypeId()` (the first group when there is no ranking) is **not** used. With no ranked group, Confirm is refused (`no_ranked_group`). If the chosen group has no recipe, Confirm is refused (`no_recipe`). Neither moves to another group.
- Research's signed "rep may change the archetype on the card" (v3 §3, derived views) is not offered in H1. Offering it later changes only the adapter's selection, not this contract.
- A partial pack may be confirmed when it has a ranked group and that group has a recipe (orchestrator A1 item 2).

## 4. Candidate search (replaces v2 §4.3)
- Page only until `howMany` eligible candidates exist, or until the next request would break the spend invariant (§6). No spare pool is bought on purpose. No "look further" in H1.
- The page size is fixed for a search run: `clamp(howMany, providerMinPageSize, 50)`. `providerMinPageSize` is **UNKNOWN**, 10 per the old V3 client.
- `maxContactsPerCompany = 3` is sent where the provider supports it (**UNKNOWN** whether it is a request parameter). A deterministic local cap of 3 always applies.
- Countries and locations are never widened.

## 5. Provider translation (replaces v2 §4.1 and note 1's mechanics; note 1's "never drop a location" stands)
Lead gen owns translation. The rep never sees provider taxonomy or ids. Translation runs before the first search, against cached provider filter metadata (`fetchedAt` and a hash are recorded in the translation Event).

| Field | Rule | When it cannot map |
|---|---|---|
| titles | Sent as provider title text | — |
| excludeTitles (+ `exclusions.roles`) | Provider exclude where supported; always a local whole-phrase guard | — |
| countries | ISO code matched to the provider country value | halt `unmappable(country)` |
| locations | Normalised exact match of the name or a `places` alias, at state or city level, inside the recipe's countries; ties broken by country | halt `unmappable(location)`, Edit brief. A wider region is never substituted |
| sizeBand | Exact range if the provider takes free ranges. Else only buckets **wholly inside** the band (narrowing); the effective range is recorded | halt `would_widen(sizeBand)` only when no inner representation exists |
| industries | (1) Normalised exact label match. (2) A small curated alias table in the repo (Research label → provider label text; ids resolved from metadata). (3) Otherwise needs you, with up to 3 plain-language choices drawn only from the narrowest provider level (sub-industries), minus anything naming an `exclusions.orgTypes` term. The choice is recorded and the search resumes | no candidate choices: halt `unmappable(industry)`, Edit brief |
| triggers | Not a filter, never a halt | — |

## 6. Spend (replaces v2 §4.2, 4.3, 4.8 accounting; estimateSchema)
- **Search is a spend event.** Every provider call writes a ledger row from the response's billing charge. No fixed page cost is assumed anywhere.
- **Gate 1, Confirm plan**, authorises search spend up to `searchCreditCap` and nothing else. The default cap is configuration, TBD until billing is verified. Before the Confirm mutation, the server reads the balance from account usage and freezes the snapshot. Confirm is refused when the cap exceeds the snapshot's `remaining`.
- **Invariant**, checked before every search request (and every retry):
  `documentedWorstCaseCharge(req) <= remainingSearchCap`,
  where `remainingSearchCap = searchCreditCap − Σ(reconciled search charges + open reservations for this confirm)`.
  The same holds against `balanceSnapshot.remaining − Σ(all spend since the snapshot)`.
- **`documentedWorstCaseCharge(req)`** = the maximum across the pricing models the provider documents for a request of page size `s`. Today (unverified):
  - "1 credit per result returned" gives at most `s`;
  - "1 credit per 1–25 results" gives `ceil(s/25)`;
  - "1 credit minimum even with no results" gives 1.
  
  So the function is `max(1, s, ceil(s/25)) = s` for `s ≥ 1`, with no signals requested. Once billing is verified (§12, §13), `pricingAssumptions` names the verified model and the function uses it.
- **Reservation.** Before each call, a ledger row reserves `documentedWorstCaseCharge` (open). On a response, the row is overwritten with the charged amount. On a timeout or network failure, where the outcome is unknown, the reservation **stays at worst case** and is marked unreconciled until usage reconciliation. (This replaces v2's "delete if the call throws".)
- **The claim this makes:** search spend never exceeds the cap *provided the provider never charges more for a request than its documented worst case*. Nothing stronger is claimed until billing is verified.
- **Gate 2, Reveal emails** is a separate action. Its figure covers only the chosen candidates that need buying: not reused (§9), with an email available, and whose reveal is not already free (`canReveal` email credits > 0). That count is multiplied by the per-email reveal price (documented as 1; to be verified).
  - Reused people are attached with no provider call and no credit. A chosen set that is entirely reused shows Reveal emails at 0 credits.
  - It is all or nothing for the chosen set, at most 100 ids per request, idempotent per batch (`campaign:<id>:reveal:v<n>:b<k>`).
  - A ledger row is written per call, and per person where the response attributes the charge.

## 7. Holds (replaces v2 §4.4, 4.9–4.11)
Pre-reveal (preview only, before ranking). Each is a campaign-only hold unless marked:
1. Provider identity already known to be unusable (`invalid_id`, `wrong_person`, `no_email`; §9): excluded, so that record is not bought again. This is not a fact about the human.
2. Domain under an org-wide do-not-contact suppression (§9).
3. Firm or domain in `exclusions.firms` (domain match; the name rule of §8 when there is no domain).
4. Title matches `excludeTitles` or `exclusions.roles`.
5. Wrong geography: country not in `targeting.countries`; or, when locations are set, preview state/city not matching a location or alias, **or missing**.
6. Customer company: `findLead({domain})` returns a lead with `isCustomer`. Best-effort, positive only (approved); no match never proves "not a customer" (§10).

Reuse (pre-reveal, no spend): a candidate whose provider identity maps to a Person with a usable email is **reused**, not held (§9). It then passes the post-reveal checks below at attach time, without a provider call.

Deferred from H1: the open-deal hold (the Zoho interface has no deal read, and it is not being extended for this).

Post-reveal (only once an email exists, whether revealed now or reused). Each is a campaign-only hold unless marked:
1. Invalid id, or wrong person (name or domain differs from the preview): the provider identity is marked unusable (§9). No Person is created from the returned data.
2. No email: the provider identity is marked `no_email` (§9). No Person is created.
3. Email under an org-wide opt-out or do-not-contact suppression, or `findLead({email}).optOut`. The latter also writes the org-wide opt-out (§9).
4. A CRM person check: `findLead({email})` returns a customer lead (best-effort, positive only).
5. Not a work email, or email grade outside the configured allowed set. The proposed default is {A+, A}; the API's grade vocabulary is **UNKNOWN**. The Person keeps its email and grade; this campaign holds it.
6. `duplicate_in_campaign`: the identity resolves to a Person already enrolled in this same campaign (§9).

A Person existing elsewhere in Relay is never itself a hold. Resolving to a Person not yet enrolled here continues normally (§9).

Post-reveal holds on bought records have already cost their credit. They are recorded and shown ("K held"). There is no top-up in H1.

## 8. Ranking (replaces v2 §4.6–4.7)
No model. `norm(s)`: NFKC, lower case, "&"→"and", punctuation stripped, whitespace collapsed.
- **Score** (maximum 7):
  - `norm(title)` exactly equals a `norm(titles)` entry: +3;
  - otherwise (returned by the title-filtered search): +1;
  - seed-firm match: +2;
  - preview says an email is available, or the candidate is reused with a usable email: +2. Work versus personal is a post-reveal hold.
- Reused candidates are ranked and counted against the per-company cap exactly like any other candidate.
- **Seed-firm match:** the registrable domain equals a seed firm's domain. Only when that seed has no domain: `norm(company)` minus a trailing legal suffix (ltd, limited, plc, llp, llc, inc) equals the seed name treated the same way. No fuzzy matching.
- **Company key:** registrable domain, else `norm(company)`.
- **Selection:** repeatedly take the eligible candidate maximising
  `(score, −chosenFromSameCompany, exactTitle, seedMatch)`, then ascending `(companyKey, norm(name), lushaId)`.
  Skip a candidate whose company already has 3. Stop at `howMany`. This is a total order, so identical candidate sets give identical picks whatever order the provider returned them in.
- `whyPicked` is templated from the parts that fired.

## 9. Reuse, dedupe and suppression (replaces v2 §4.8 re-attach, §4.10, §4.13's suppression clause, and master §25 Suppression)
Principle: **Relay does not intentionally pay again for usable contact data it already owns.**

The smallest records that express the rules (entity level; columns at implementation):
- **Person** (org-level): the canonical human/contact with a revealed email. Unique per org by email.
  - Whether that email is usable is **not** a property of the Person. Each campaign decides it with its own rules: opt-out/DNC, work-email policy, the configured grade policy, and the CRM customer hold.
- **ProviderIdentity** (org-level): `(provider, providerId)` → `personId | null`, with a status of `usable | no_email | invalid_id | wrong_person`. One provider record maps to at most one Person; a Person may have several provider records.
- **CampaignPerson**: the campaign's enrolment/candidate record, not "one row per person":
  - It starts from a provider identity, with `personId` not yet known.
  - Once the identity is resolved (reused or revealed), it references the canonical Person.
  - It holds the buyer group, confirm Event and brief version; the preview snapshot, rank, score and `whyPicked`; status, the campaign-only hold reason, and `source: bought | reused`.
  - Two provider identities that resolve to the same Person in the same campaign never become two active enrolments for that human.
  - The constraints that enforce this are decided in the migration PR.
- **ContactSuppression** (org-level): an email or domain, with reason `opted_out | dnc`, source and time. That is the only org-wide human/contact suppression.

Reuse:
1. A preview whose ProviderIdentity is `usable` and maps to a Person, where that Person is not under ContactSuppression: the candidate's CampaignPerson references that Person with `source: reused`. No reveal call, no reveal credit.
   - It is ranked and capped normally (§8).
   - This campaign's post-reveal checks (§7) decide at attach time whether its email is usable here: opt-out/DNC, CRM customer, grade and work-email policy.
2. A reveal that resolves to an existing org-level Person who is **not** already enrolled in this campaign: the provider identity is linked to that Person, and the candidate continues normally through this campaign's checks.
3. A reveal (or reuse) that resolves to a Person **already enrolled in this same campaign**: the additional candidate/provider identity is `duplicate_in_campaign`.
4. The mere fact that a Person already exists elsewhere in Relay is never itself a hold.

Scope:
- **Org-wide human/contact suppression** (ContactSuppression): genuine opt-out, and DNC where a source supports it.
  - Today the only source is Zoho `Email_Opt_Out` via `findLead`, plus later reply opt-outs. There is no DNC list source in H1.
  - Retention follows master PART IX (open).
- **Provider-identity unusable state** (ProviderIdentity status): `invalid_id`, `wrong_person`, and `no_email` (a record Relay already paid to reveal and got no usable email).
  - It stops Relay rebuying *that provider record*. It is not a statement about the human or the company, and it does not block the same human reached through another record.
  - There is no expiry in H1. It follows the record's retention, which is open, and is not a never-purged suppression.
- **Campaign-only holds** (CampaignPerson hold reason; never written anywhere org-wide):
  - wrong geography, excluded firm, excluded title or role;
  - per-company cap;
  - email grade or work-email policy;
  - customer company (re-checked against CRM each run);
  - `duplicate_in_campaign`.
- There is no generic suppression framework, and no "know them already" reason in H1 (swap is deferred).

## 10. CRM (Zoho) — what the current adapter guarantees
`ZohoService.findLead({ email?, domain? }) → { id, optOut, isCustomer } | null` (`src/lib/services/types.ts:130,149`).

Live behaviour (`src/lib/services/zoho/live.ts:108–141`):
- It searches the **Leads module only** (not Contacts, Accounts or Deals).
- Email is searched first; the domain is used only if the email finds nothing, and then only as `Website:equals:<domain>` for a plain hostname.
- It returns the **first** matching lead only.
- `isCustomer` is `Lead_Status === "Customer"` on that lead. `optOut` is `Email_Opt_Out`.
- One token refresh on 401. No 429 retry. Any other failure throws `ServiceError`.
- There are no callers in application code today.

What this honestly supports:
- **Post-reveal:** whether this email is a Zoho lead that is opted out, or marked Customer.
- **Pre-reveal, positive only:** a lead whose Website field equals the preview's domain **and** is marked Customer means hold. Neither a null nor `isCustomer: false` proves "not a customer". Customers held as Accounts or Contacts, leads with Website written as `www.` or a URL, and a customer lead that is not the first match at a domain are all missed.

Lead gen wraps these calls in its own bounded retry; the interface is unchanged.

## 11. Campaign state (extends orchestrator A1 item 8; no stored state)
Derived from the campaign, the current brief version and, at that version:
- the latest `campaign.confirmed` Event;
- the latest `lead_gen` Job and its `leadgen.picked` / `leadgen.halted` Event;
- the latest `campaign.reveal_confirmed` Event, the `reveal` Job and its `leadgen.revealed` Event.

Evaluated from the latest step backwards.

| State | Condition | Chip | Action | Edit brief |
|---|---|---|---|---|
| planReady | research planReady; no confirm at this version | Plan ready | Confirm plan | yes |
| findingPeople | confirmed; `lead_gen` queued/running | Finding people | — | no |
| peopleFound | `leadgen.picked` with X ≥ 1 eligible; no reveal confirm | People found (+ "X of N" and the shortfall reason when X < N) | Reveal emails (X) | yes, with warning |
| revealing | reveal confirmed; `reveal` queued/running | People found (line: revealing emails) | — | no |
| peopleReady | `leadgen.revealed` | People ready ("R ready, K held") | — | no (this slice only; not a Relay-wide rule) |
| failed | a `leadgen.halted` Event, or a failed `lead_gen`/`reveal` job | Needs you + reason | per reason: Try again / choose an industry / Edit brief | yes, with warning when anything was spent |

Halt reasons:
- `no_candidates` (0 eligible);
- `unmappable(field)`, `would_widen(sizeBand)`, `choose_industry`;
- `over_cap`, `balance_unavailable`;
- `provider_busy`, `took_too_long`.

`no_ranked_group` and `no_recipe` refuse Confirm itself; they never create a job.

The Edit brief warning, when search or reveal credits have been spent at this version: "Changing the brief discards this selection. Credits already spent stay on the record, and another search may spend more."

The four Finding-people states all mark the signed "Finding people" step.

In peopleFound, X counts bought and reused candidates alike. The Reveal emails figure counts only those still to be bought (§6).

## 12. Lawful basis (replaces "record LIA" in orchestrator §5 for this slice)
At Confirm, before any processing, the `campaign.confirmed` Event stores the exact lawful-basis text the rep confirmed, the actor, the time and the brief version. This is the "one text field and a timestamp" of module reference 5.4.

It is labelled **"Lawful basis confirmed"**, never an LIA. The content of a real LIA, and master PART IX (lawful basis for stored contact data, retention), are open. Provider-free implementation proceeds. **Live production processing waits for that decision.**

## 13. Verification before any rep
Zero-spend metadata check (no search or enrich endpoint, one class at a time). Then the paid live smoke, revised from v2 rubric row 13:
- a throwaway campaign, the smallest cap;
- ledger equals the usage delta;
- a no-email reveal suppresses; a wrong person is held;
- a 429 is retried;
- billing per request is recorded.

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

## 15. Deliberately not here (H1)
Swap, Find more, Add someone, a group chooser (the contract already allows one; §3), the open-deal hold, a verification provider, phone, Outreach and drafting, DNC list sources beyond Zoho opt-out, and re-checking `no_email` records.

## 16. Master and orchestrator edits implied
- §7.3, §13 (line 370) and §23.1e: remove "free preview" and "one search credit per page". Search is spend.
- §23.1e: "Reveal N and start drafting" becomes "Reveal emails". Swap, Find more and Add someone are later.
- §25 People:
  - "Person (unique per org by Lusha id and email; preview facts … purge date)" is split as §9: Person unique by email; ProviderIdentity holds the Lusha id; the preview facts and their purge date move to CampaignPerson (the Enrolment row).
  - "Suppression (… Lusha id; reason incl. `no_email|wrong_person|invalid_id|known`; … customer and open-deal cache)" becomes ContactSuppression (`opted_out|dnc`) plus the ProviderIdentity status. The customer and open-deal cache is dropped: the customer check is re-run per campaign, and open deal is deferred.
- Orchestrator §5: Confirm plan → Finding people (`lead_gen`), People found → Reveal emails → People ready (`reveal`, no `draft`). A1 item 8 is extended by §11.
- Copy (`src/lib/copy/campaigns.ts`):
  - `peopleBeforeConfirm` (338–339), `confirmLater` (107), `creditsReveals` (317) and `lawfulBasis` (323) are reworded;
  - "Lawful basis confirmed" is added.

## Appendix A. Zero-spend metadata check (only on the product owner's go)

**Preconditions:**
- A Relay-only Lusha key, placed in the secrets file by the product owner. If the key is shared with any other Lusha consumer, that consumer is paused for the window.
- No search or enrich endpoint is called at any step.
- Calls are spaced at least 13 seconds apart (usage is limited to 5 a minute).
- Responses and headers are kept as internal evidence. Metadata carries no personal data.

| Step | Call | Proves | Stop if |
|---|---|---|---|
| 0 | `GET /account/usage` three times (the documented path; the V3 path only if that one 404s) | The usage read itself is free; the base path; balance, plan, any per-action prices; the `x-rate-limit-*` headers | `used` moves |
| 1 | One `GET …/filters/companies/sizes`, then usage | The class "company filter GET" is free; free range or buckets; the exact size representation | `used` moves |
| 2 | `GET …/filters/companies/industries_labels`, then usage | Main and sub-industry ids for the insurance example | `used` moves |
| 3 | One `POST …/filters/contacts/locations` with "Orkney", then usage | The class "location lookup" is free; whether Orkney exists, at which level, and its shape | `used` moves |
| 4 | Same class: "Orkney Islands", "United Kingdom", "Ireland", then usage | Aliases and country values | `used` moves |

**Not provable at zero spend.** These come from written confirmation by the Lusha account manager, and then the paid smoke:
- the search billing model and minimum page size;
- whether `maxContactsPerCompany` is a request parameter;
- the email grade vocabulary;
- whether a timed-out request is charged;
- per-person charge attribution on enrich.

# Relay agent definition — Lead gen (v2.2, signed)
**v2.2 · SIGNED by the product owner 2026-09-14 · amends `leadgen.v2.1.signed.md`; where the two differ, v2.2 wins**
Inputs to this amendment: the account-led audit of `main` 64ec0e8 (`ops/design/2026-09-14-relay-leadgen-v2.2-account-led-audit.md`), accepted by the product owner on 2026-09-14 with these decisions:
- Direct motion is accounts first;
- runs is the lead role;
- pending is not kept;
- the account target is `ceil(howMany / 2)`;
- the lead title limit is `ceil(howMany / 4)`;
- the stage name is "Reviewing people";
- no company search, no account table, and no Research change.

Everything in v2.1 stands unless a section below replaces it. A Confirm frozen under v2.1 (`LeadGenHandoffV1`) keeps running under v2.1 unchanged.

## 3a. Input: `LeadGenHandoffV2` (extends v2.1 §3)
The handoff Confirm freezes from now on is V1's shape with `version: 2` and two additions:

```ts
type LeadGenHandoffV2 = Omit<LeadGenHandoffV1, "version"> & {
  version: 2;
  play: { id: string };                 // the confirmed campaign candidate (m16 id): provenance only
  buyerRoles: {                         // the confirmed group's roles, copied verbatim
    title: string;                      // as Research wrote it, compound forms included
    seniority: string;
    part: "runs" | "champions" | "signs";
    needs: string;
  }[];
};
```

- The campaign boundary adapter copies `play` and `buyerRoles` at Confirm, from the same group it already selects (v2.1 §3).
- Lead gen still imports nothing of Research. It declares these fields itself.
- A historical handoff is never rewritten. Lead gen runs a V1 handoff under v2.1 and a V2 handoff under this amendment.

## 4a. Account-led search (replaces v2.1 §4 for a V2 handoff)
Every request keeps v2.1 §5 translation and the v2.1 §6 spend invariant and reservation, unchanged. No title, place, industry or size is widened.

**Roles in the recipe.** Each recipe title is matched to a role (§8a). This partitions the recipe's titles by role. A title that matches no role stays in the recipe, but is not a discovery or complement title.

**Search 1, account discovery:**
- It takes the recipe titles matched to `runs`. If there are none, it uses those matched to `champions`, then `signs`, then every recipe title.
- `maxContactsPerCompany = 1`.
- `pageSize = clamp(targetAccounts, providerMinPageSize, 50)`, where `targetAccounts = ceil(howMany / 2)`.
- It pages only while fewer than `targetAccounts` accounts have a lead (§8a). A further page is taken only if the remaining cap still covers that page and the smallest complement request.

**Search 2, complementary roles:** one request, and never paged. It is restricted to the domains of the accounts with a lead, and includes:
- the recipe titles matched to parts other than the discovery part;
- `maxContactsPerCompany = min(perCompanyMax − 1, the number of those parts)`;
- `pageSize = clamp(min(howMany − leads, accounts × maxContactsPerCompany), providerMinPageSize, 50)`, reduced to what the remaining cap allows, but never below the provider minimum.

When the cap cannot cover even the minimum, the complement search is not made, and People found shows the cap shortfall.

**Other rules:**
- An account with no domain is not sent in the complement search.
- A complement result outside those accounts is ignored.
- Confirm's cap must cover the first discovery page plus the smallest complement request before anything is searched, otherwise the run halts `over_cap` with nothing spent.
- For `howMany = 20`, the worst case is 10 (discovery) + 10 (complement) = 20.

## 8a. Roles and allocation (replaces v2.1 §8 selection for a V2 handoff; its score, seed match and `norm` stand)
**Role matching,** per confirmed group and never global:
- Each role title is split on Research's own " / " and " or ", and each piece is normalised with `norm`.
- A title whose `norm` equals a piece is an **exact** match.
- Otherwise, a piece of two or more words, at least one of them not generic, found as a whole phrase in the title is a **phrase** match. The generic words are: head, of, and, the, chief, officer, manager, director, lead, senior, analyst, executive, deputy, assistant, team, leader, vice, president, vp.
- A single word never phrase-matches.
- When matches point at different parts, there is no match.
- A title with no match is **Related role**. Seniority and departments never assign a role.

**Strong:** a role match, or an exact recipe title. Nothing weak is ever chosen.

**Account key:** the registrable domain, else the provider's company id, else `norm(company)`.

**Account order,** ascending by:
1. number of distinct parts among its strong candidates, most first;
2. seed-firm match first;
3. best score first;
4. account key.

The provider's order never decides.

**Order within an account,** ascending by:
1. part: runs, champions, signs, then none;
2. match: exact before phrase;
3. score, highest first;
4. `norm(name)`;
5. provider id.

**Passes:**
1. **Leads:** accounts in order each take their first strong candidate, until `targetAccounts` accounts have a lead. A lead whose `norm(title)` already leads `ceil(howMany / 4)` accounts is skipped for the account's next candidate.
2. **Complement:** each lead account, in order, adds its first candidate with a part not yet chosen there. The lead title limit does not apply to complements.
3. **Third role:** the same again, adding a third distinct part.
4. **More accounts:** if still short, further accounts take a lead only.

- Never two people with one part at an account, and never more than `perCompanyMax` (3).
- Stop at `howMany`. Never pad.
- Fewer than asked is People found X of N, with the shortfall `cap_reached` when the cap stopped a search, and otherwise `fewer_strong_matches`.

## 9a. Review before Reveal (extends v2.1 §9 and §11)
CampaignPerson gains:
- the matched role (part, the Research role title, and the method);
- the rep's review: `pending` (default), `kept` or `dropped`, with who and when.

Keep and drop write the rows and a `campaign.people_reviewed` Event in one transaction. Drop account marks every chosen person at that account. There is no account record.

**State and screens:**
- The peopleFound state reads **Reviewing people**. Its screen leads with accounts, with people nested under each account.
- Gate 2 (Reveal emails, still not built) takes **kept** chosen people only. Pending and dropped are never revealed, and the reveal estimate counts kept people only.

## 15a. Still not here
Company search, a CampaignAccount table, running several plays, choosing another play, Reveal, People ready, Outreach, and any Research change.
