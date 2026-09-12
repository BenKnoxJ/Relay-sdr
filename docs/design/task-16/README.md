# Task 16: the research loop (widen, Edit brief, Try again)

Orchestrator amendment A1, items 4 to 6, on real campaigns. Shot in headless
Chrome against the dev server over `scripts/seed-campaigns.ts` data. No worker
ran, so no research ran.

| File | What it shows |
|---|---|
| `campaign-stopped.jpg` | The signed stop (mock 3c) beside the built one: research's three options as a choice. |
| `stopped-option-2-chosen-keyboard-light-1440.png` | Option 2 chosen by keyboard (Tab onto the group, arrow down). The two region options are numbered; each says what the brief would become. Research's own text is unchanged. |
| `stale-tab-refused-light-1440.png` | A second tab, opened on version 1, chooses after the first tab widened: refused in words, nothing written. |
| `campaign-plan-ready.jpg` | Plan ready with Edit brief on the brief card; Confirm plan still cannot be pressed. |
| `edit-brief-light-1440.png`, `edit-brief-dark-390.png` | Edit brief: Start's card on the current brief, no sentence step, nothing guessed. |
| `plan-ready-after-who-edit-renamed-light-1440.png` | After Edit brief changed Who: the name is made again from the new words (it is derived from Who, not a title the rep typed). |
| `campaign-failed.jpg`, `failed-try-again-dark-390.png` | Needs you after research failed: the reason, Try again in the header, Edit brief on the card. |

## Divergences from the signed mock

1. **The stop's action is on the chosen option** ("Look again with this"), not
   a header "Widen the brief": §23.1c as amended says the rep chooses one.
2. **Repeated headings are numbered** ("Widen the region · option 1", "· option
   2"), and each option carries a "becomes" line computed from the brief it
   would make. Research's text is shown as written. A constraint the option
   takes off reads as removed ("Kinds of organisation limit removed"); one the
   rep never set reads as not set. Relay never fills one in.
3. **Change something and its reason picker are gone**, replaced by Edit brief
   (A1, item 5).
4. **Try again appears only when the research job itself failed.** A result
   Relay could not read also needs the rep, and offers Edit brief only.
5. The top nav still overflows at 390px (deferred to shell work).
