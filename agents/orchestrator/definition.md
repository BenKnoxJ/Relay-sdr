# Relay agent definition — Orchestrator (v2, signed)
**v2 · SIGNED by Benny-san 2026-09-08 · supersedes v1 · audit: `reviews/2026-09-08-review-orchestrator-depth.md`**
Contract: master §7.3 Orchestrator, §9, §12. Screens: Home (§23.1a), Start (§23.1d), campaign page (§23.1c).

What changed from v1, in one line: v1 got the shape right (code, not model; three model calls); v2 adds what the fleet's own orchestrator learned the hard way: durable ids, idempotent enqueue, typed halt reasons, timeouts, a pause that reaches the scheduler, and a brief version, so slug drift, duplicate dispatch and false failure cannot replay inside the product.

## 1. Job, in one line
Turn a sentence into a confirmed campaign brief, run the specialists in the locked order, hold the campaign state, and answer the rep in their own words from counts and state. Never sends, posts or spends.

## 2. Model steps (still exactly three)
| Step | Input | Output | Rules |
|---|---|---|---|
| **Pre-fill** | sentence; product list; allowed values; defaults | `BriefDraft{ product?, motion?, who?, region?, howMany?, weeks?, channels?, guessed[] }` | fill only what the sentence supports; never invent a product; `who` keeps the rep's words; one call on Start, ≤400 tokens |
| **Name** | confirmed brief | `{ name }` ≤40 chars | rep words; renamable |
| **Answer** | one of six fixed questions + `CampaignView` (counts, state, `reason?`, `running?: {kind, since}`, `nextEvent`, `spend: {credits, model}`) | `{ answer }` ≤2 sentences | the model phrases, never computes; if the view cannot answer, say so and name `nextEvent` |
No fourth call. "Change something" reasons are a picker plus a free-text note stored verbatim; no model reads them.

## 3. Durable identities (so nothing is keyed by a string someone can shorten)
- `campaignId` (cuid) is the only campaign identity. Names are labels.
- `briefVersion` (int, starts 1) increments on every "Change something"; every pack, plan, job and touch records the `briefVersion` it belongs to.
- Every enqueue is idempotent on `idempotencyKey = campaignId:kind:briefVersion:attempt`. A second Start, Confirm or Reveal press returns the existing job (§25 rule 2; queue `enqueue` dedupes per org).

## 4. Job-row contract (what §5's side effects reference)
Each specialist run is one `Job` with: `kind` (`research|lead_gen|reveal|draft`) · `campaignId` · `briefVersion` · `attempt` · `trigger` (`rep|system|retry`) · `status` · `timeoutMs` per kind (research 20 min, lead_gen 5 min, reveal 5 min, draft 10 min) · on completion `validity` (`valid|invalid_output`) after schema validation · `costModel` and `costCredits` · on failure `reason` from the vocabulary in §7. The worker (Task 5) enforces the timeout; the orchestrator never waits in memory.

## 5. The state machine (code, not model)
```
Brief → Researching → Plan ready → Finding people → Drafting → Running → Done
                ↘ Researching (stopped)  ── widen → Researching
any running state ⇄ Paused        any state ──(failed twice | invalid_output | timed_out)──▶ same state + needsYou
```
| From | Event | To | Side effect (`mutate` + Job) |
|---|---|---|---|
| Brief | Start research | Researching | enqueue `research` (brief, facts version, breadth, briefVersion) |
| Researching | research valid | Plan ready | store pack@briefVersion; Event `research.completed` |
| Researching | research `insufficient` | Researching (stopped) | store findings + widenings; Event `research.stopped` |
| Researching (stopped) | Widen | Researching | briefVersion+1; enqueue `research` with `priorRun` |
| Plan ready | Confirm plan | Finding people | record LIA; enqueue `lead_gen` |
| Finding people | Reveal | Drafting | enqueue `reveal`, then `draft` for touch 1 per person |
| Drafting | first drafts exist | Running | Event `campaign.running`; scheduler owns touches |
| Running | Pause | Paused | see §6 |
| Paused | Resume | previous state | scheduler resumes; jobs held in `queued` become claimable |
| Running | last touch resolved | Done | Event `campaign.done` |
| Plan ready or later | Change something (reason) | Researching | briefVersion+1; **touches frozen** (not cancelled), revealed people kept, new pack version; enqueue `research` |
| any | job `invalid_output` | same + needsYou(`bad_output`) | pack or list stored as rejected; no auto-retry |
| any | job `timed_out` | same + needsYou(`took_too_long`) | one automatic retry with `trigger=retry`, then needsYou |
| any | job failed with `provider_limit` | same (no needsYou) | retry with backoff (1, 5, 15 min); does **not** count toward "failed twice" |
| any | job failed twice (non-provider) | same + needsYou(`failed_twice`) | Event with the plain reason |
| needsYou | rep presses Try again | same, needsYou cleared | enqueue with `attempt+1` |
Illegal transitions are rejected in code and tested table-driven.

## 6. Pause and kill switches
- **Pause (per campaign)** gates three things at once: no new enqueue for the campaign; the scheduler does not claim its touches; in-flight jobs for it finish their current step then stop (the worker checks `paused` between steps and requeues). Pause is allowed from any running state and always returns to the state it left.
- **Org kill switch** (admin, §8): same three gates for every campaign in the org, plus mailbox sends. Stored as a row, checked by the worker on every claim, so it works below the model.

## 7. Reason vocabulary (copy file; Home and the campaign page render the reason, never the word "needs you" alone)
`bad_output` "Relay's research came back in a shape it could not use" · `took_too_long` "A step took longer than it should; try again or change something" · `failed_twice` "A step failed twice: <plain error>" · `not_enough_evidence` (the insufficient path) · `mailbox_paused` "Your mailbox is paused: <why>" · `credits_capped` "Credits for this month are used up". Each has a next action on the campaign page: Try again, Widen the brief, Change something, or Settings.

## 8. Fixed question set (answered from `CampaignView`)
1. How is this campaign going? 2. What is waiting on me? 3. How many have replied, and how? 4. When does the next batch go? 5. What has this cost? (credits and model spend) 6. Why is this paused or stopped? (the §7 reason plus what is running and for how long). Anything else → the fixed copy line listing the six.

## 9. Stop-and-ask rules (unchanged, now typed)
Missing field → dashed on the Start card. `insufficient` → findings and widenings. Plan ready → nothing spends. needsYou → reason and action from §7.

## 10. Rubric (sign-off gate on the bench)
| # | Check | Pass |
|---|---|---|
| 1 | Pre-fill schema and honesty | 20 fixture sentences; partials leave fields empty and listed in `guessed`; no invented product; `who` diff ≤20% |
| 2 | Names | ≤40 chars, plain words |
| 3 | Answers | six questions on three fixture views; every number equals the view; Q6 names the reason and what is running |
| 4 | State machine | every §5 row passes; every illegal transition rejected |
| 5 | Idempotent enqueue | double-tap Start, Confirm and Reveal each yield one job |
| 6 | Pause | property test: no job for a paused campaign is ever claimed; an in-flight job stops at the next step boundary and is requeued; resume returns to the prior state |
| 7 | Halt reasons | fixture: malformed research pack → `bad_output` + needsYou, nothing spent; timeout → one retry then needsYou; provider 429 → backoff, no needsYou |
| 8 | Change something while Running | touches frozen not cancelled; revealed people kept; new pack under briefVersion+1; old pack still readable |
| 9 | No spend before confirm | property test across states |
| 10 | Words | `assertPlainWords` on every model output, state line and reason |
| 11 | On screen | Start pre-fill from three sentences; the six answers in the Ask Relay box; a needsYou reason with its action, all on the bench |
| 12 | Cost | pre-fill + name < $0.02 per campaign; answer < $0.005; per-campaign cost visible in Q5 |

## 11. Deliberately not here
Re-planning, memory across campaigns, free-form chat, choosing which specialists run. H2 per §9 and §11.

## 12. Resolved from v1's open questions (recommendations taken unless you say otherwise)
1. The six questions live in an **Ask Relay** box on the campaign page: six chips, no free text; added to 9b's component inventory. 2. Pre-fill runs on Start only. 3. Campaigns are model-named, renamable.
