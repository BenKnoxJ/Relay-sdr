# Task 6b — design conformance

The signed mock beside what this branch renders, one image per signed state.
Phase 1 plan, conformance guard 1: *"A page without this comparison is not
reviewable."*

What is being compared here is a **component**, not a page. The bench renders
slice 1's screens from checked-in output, so each image puts a signed slice 1
frame beside the same content drawn by the components this task builds. The
bench's own chrome around it — the title line, the "what it cost" card, the
checklist below — is a development surface and is not in the mock; so is the
absence of the nav and the step strip, which belong to the pages slice 1 builds
and not to these components.

| Image | Signed state | Reference |
|---|---|---|
| `plan-cards.jpg` | The plan, one card expanded, and the unknowns card | mock section 3b-ii |
| `approve-card.jpg` | A draft selected on the Inbox | mock section 2a |
| `your-people.jpg` | Your people, after the reveal | mock section 3f |
| `start-prefill.jpg` | Start, pre-filled, guessed fields dashed | mock section 3d |

Light and dark are both shown because the palette switches on one attribute and
a token used wrongly usually only shows in one of them.

Known differences, all deliberate:

* **No "Change something about this…", no reject reasons, no step strip.**
  Those are slice 1 interactions. Every control the bench draws is `disabled`:
  a bench that could approve a draft would be a way to send email from a page
  whose purpose is looking at things.
* **"2 kinds of buyer" where the mock says "2 archetypes".** `MACHINE_WORDS` in
  `src/lib/copy/plainWords.ts` bans that word outright, and the copy sweep is
  the rule with a test behind it. The two signed documents disagree; which one
  gives is Benny-san's call. Recorded in `src/lib/copy/plan.ts`.
* **Fewer rows and fewer sources than the mock draws.** The mock is drawn with
  invented content at full size; these are the checked-in fixtures, which are
  as large as the definitions' own examples.

Regenerate:

    npm run dev                      # with DEV_USER_EMAIL set
    SET=6b MOCK=file://…/2026-09-07-shell-mock-signed.html APP=http://localhost:5200 \
      node scripts/design-shots.mjs
