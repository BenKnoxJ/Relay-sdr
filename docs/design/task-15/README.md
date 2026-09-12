# Task 15 — design conformance: the Campaigns screens on real campaigns

The signed mock beside what this branch renders. The campaign pages now read
the database, so the shots are of real campaigns: one per state a campaign can
reach today, started through the real write path and settled with signed
research contract data by `scripts/seed-campaigns.ts` (no research was run).

    DATABASE_URL=…/relay_pa_dev npx tsx scripts/seed-campaigns.ts --email <rep> --with-mailbox --out ids.json
    MOCK=file://…/2026-09-07-shell-mock-signed.html SET=15 CAMPAIGN_IDS=ids.json node scripts/design-shots.mjs

| Image | State | Reference |
|---|---|---|
| `campaigns-list.jpg` | The list: five real campaigns, one per state | mock 3a, §23.1c |
| `start.jpg`, `start-prefilled.jpg` | Start, with who exactly under the signed card | mock 3d, §23.1d (amended 2026-09-12) |
| `campaign-researching.jpg` | Researching: the brief, the 20 to 45 minute line, no spinner | §23.1c |
| `campaign-plan-ready.jpg` | Plan ready on a complete pack; Confirm drawn, not pressable | mock 3b, §23.1c |
| `plan-expanded.jpg` | The plan with one card open | mock 3b-ii |
| `campaign-partial.jpg` | Plan ready on a partial pack: the missing parts named | orchestrator A1; no mock |
| `campaign-stopped.jpg` | The stop: research's reason, the evidence it cites, its own options | mock 3c, §23.1c (amended 2026-09-12) |
| `campaign-failed.jpg` | Research did not finish: the reason in words | orchestrator §7 / A1; no mock |
| the rest | Unchanged by this task, reshot so the sheet is whole | Tasks 9b, 9d, 9e |

Running and Done are not shot: no real campaign can reach them until lead gen
exists. The component snapshots keep their markup.

## Known divergences from the mock

1. **"New campaign" is in the nav once a rep has a campaign**, as the mock
   draws it, now that `me.hasCampaign` is real (Task 9c's note); the list page
   carries no second copy of it. A rep with no campaigns, who has no nav CTA
   yet, gets a direct New campaign button on `/campaigns`' empty state that
   goes straight to Start, rather than being sent back to Home's brief box.
2. **Plan ready is drawn from the runtime's synthetic complete pack.** No
   committed live pack passes today's v3.2 rules whole (brief A v3.1 predates
   note 25), so `campaign-plan-ready.jpg` shows `goodPack()` content
   ("claims-teams firm 1"). The screen is real; the words are test data.
3. **The partial shot is brief B's targeted run** (three of twenty-two parts),
   so the missing list is long and three cards read "0". A rail-cut full run
   would miss far fewer parts.
4. **No downstream numbers.** Progress, the list's count and the plan's
   people, credits and sending lines are absent or words until lead gen: the
   mock's zeros read like work done.
5. **Confirm plan is drawn and cannot be pressed**, with the line saying
   finding people comes next. Widen, Change something and Your people are
   absent on a real campaign until they are built.
6. **The stop shows research's own reason and evidence at length.** The mock's
   two-line summary was drawn before v3.2; the evidence items are the pack's
   m00/m01 items as written, each with its source and confidence word.
7. **A campaign is named from the rep's own words**, cut inside forty
   characters, and keeps their casing ("veterinary practices in Orkney"); the
   orchestrator's naming call does not exist yet.
