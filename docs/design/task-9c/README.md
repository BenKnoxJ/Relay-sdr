# Task 9c — design conformance

The signed mock beside what this branch renders, one image per signed state.
Phase 1 plan, conformance guard 1: *"A page without this comparison is not
reviewable."* Neon reviews a divergence from the mock or the tokens as a
finding with a severity, never a preference; Benny-san signs each page on
sight.

Produced by `node scripts/design-shots.mjs` against a development server on the
fixtures in `src/lib/fixtures/campaigns.ts`.

| Image | Signed state | Reference |
|---|---|---|
| `campaigns-list.jpg` | Campaigns, the list: three rows, chips, counts, next lines | mock 3a, §23.1c |
| `start.jpg` | Start with nothing said yet | mock 3d, §23.1d |
| `start-prefilled.jpg` | Start pre-filled from a sentence, guessed fields dashed | mock 3d, §23.1d |
| `campaign-researching.jpg` | Campaign page, Researching: the brief and one line, no spinner | §23.1c |
| `campaign-plan-ready.jpg` | Campaign page, Plan ready: the plan leads, Confirm plan | mock 3b, §23.1c |
| `plan-expanded.jpg` | The plan with one card open, and the unknowns card | mock 3b-ii, §23.1c |
| `campaign-running.jpg` | Campaign page, Running: progress leads, plan folded, Pause | mock 3c, §23.1c |
| `campaign-stopped.jpg` | The research stop: findings and the three widenings | mock 3c, §23.1c |
| `home-day-one.jpg`, `content-coming.jpg`, `inbox-empty.jpg`, `settings.jpg`, `home-dark.jpg`, `home-focus.jpg` | Unchanged by this task, reshot so the sheet is whole | Task 9b |

Light and dark are both shown because the palette switches on one attribute
and nothing else, so dark is where a hard-coded colour surfaces.

## Known divergences from the mock

Each is a deliberate choice, listed so the review rules on it rather than
discovering it.

1. **"2 groups", not "2 archetypes".** The mock's own words for the first plan
   card's meta line are "2 archetypes · 14 sources". `archetype` is on the
   banned list in `src/lib/copy/plainWords.ts`, and the rep-words rule (§22.4)
   outranks the drawing, so the card says "groups". Same reason the fourth
   confidence word is "a guess" and never the schema's `speculative`.
2. **"New campaign" is on the page, not in the nav.** The mock draws it in the
   nav pill, which 9b hides until `me.hasCampaign` is true — and that is still
   a hard-coded `false` in the me router, because there is no `Campaign` model
   to count. §23.1c asks for it "top right", so it is top right on the list
   page. Flipping it to the nav is two lines once campaigns are real, and it
   should move then rather than be duplicated now.
3. **Who keeps the rep's sentence.** The mock's Who field shows a tidied
   version ("… MD or Sales Director."); this shows what the rep actually typed,
   because orchestrator §2 says the pre-fill "keeps the rep's words". A model
   will tidy it when there is one; a regular expression must not.
4. **Region is dashed when the sentence did not name one.** The mock draws it
   solid. §23.1d's rule is "fields the sentence did not cover show dashed with
   the default chosen", and a sentence with no region in it is one of those.
5. **The sentence carries its question.** The mock's Start card opens straight
   into the sentence; this labels it with the §23.1d question, because a rep
   who pressed "New campaign" rather than arriving from Home's box has not been
   asked it yet.
6. **Ask Relay is on every state.** It is not in the mock at all: §23.1c gained
   it on 2026-09-08, after the mock was signed. It sits where the signed
   section puts it, directly under the brief.
7. **Progress shows on Researching and on the stop.** The mock draws neither
   state with it. It is five zeros and it is the same card in the same place,
   which reads better than a rail that changes shape between states.
