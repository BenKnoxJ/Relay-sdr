# Orchestrator — pass rubric

Copied from `definition.md` §10, so the gate and the signed contract cannot drift. The definition is the
source; edit it there and re-copy.

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
