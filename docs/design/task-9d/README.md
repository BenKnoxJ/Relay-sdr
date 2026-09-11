# Task 9d — design conformance

The signed mock beside what this branch renders, one image per signed Inbox
state. Phase 1 plan, conformance guard 1: *"A page without this comparison is
not reviewable."* Neon reviews a divergence from the mock or the tokens as a
finding with a severity, never a preference; Benny-san signs each page on
sight.

| Image | Signed state | Reference |
|---|---|---|
| `inbox-draft.jpg` | A draft selected: who, evidence, subject, body, chips, Approve / Edit / Reject | mock section 2a, master doc §23.1b |
| `inbox-draft-reject.jpg` | The same draft with Reject pressed: the four reasons | mock section 2a ("Reject opens") |
| `inbox-needs-you.jpg` | A draft that needs the rep: warn chip in the row, the reason above the body | mock section 2a, notes |
| `inbox-reply.jpg` | A reply selected: their message, the sent email collapsed, four labels | mock section 2b |
| `inbox-call.jpg` | A call selected: the number in mono, why call, four outcomes | mock section 2c |
| `inbox-call-spoke.jpg` | The same call after Spoke: the one-line notes box | mock section 2c |
| `inbox-empty.jpg` | Every row worked: "All clear. Next drafts Thursday 09:00." | mock section 2c, §23.1b |

Light and dark are both shown because the palette switches on one attribute
and nothing else, so dark is where a hard-coded colour surfaces.

## Known divergences from the mock

Each of these is a deliberate choice of the signed **tokens** or the master
doc's words over something that appears only in the mock's own drawing. They
are listed so the review rules on them rather than discovering them.

1. **The reject reasons are behind Reject.** The mock draws them under the
   card at all times with the label "Reject opens:", which is the mock
   explaining itself. §23.1b says "Reject is one of four reasons", so the
   built card shows them once Reject is pressed (`inbox-draft-reject.jpg`) and
   not before.
2. **The notes box is behind Spoke.** The mock draws it under the outcomes
   with the placeholder "(only after Spoke)". The built card shows it only
   after Spoke, as the placeholder says (`inbox-call-spoke.jpg`).
3. **The call number is 20px, not 22.** The mock's 22 is not on the signed
   nine-size type scale; `text-20` is the nearest size the scale has.
4. **The header note.** The mock's 2c frame shows "1 call · 3 drafts" because
   it draws the queue after the replies were worked. The built page counts
   what is actually waiting, so with the full fixture set it reads "2 replies
   · 1 call · 3 drafts" until the replies are labelled; the empty frame reads
   "nothing waiting" as the mock does.
5. **"Why call" ends on the talking point's question.** The mock writes "ask
   who takes the weekend calls"; the built line is the thread's context, then
   the call draft's opening line and its one question verbatim from the
   signed outreach output (`callDraftSchema`), so a live agent's talking point
   lands without a page change.
6. **Draft bodies.** The mock's drafts are shorter and ask two questions. The
   built fixtures are parsed through the signed outreach contract, which
   allows one question and requires it to be the ask, so the bodies are the
   contract's shape rather than the mock's.
7. **Reply preview in the row.** The mock's row quotes a short paraphrase; the
   built row quotes the first line of the actual message, truncated.

## Carried, not fixed here

The avatar's initials are `text-action` on `bg-soft` (4.33:1 in light), the
9a `soft`-as-text gap routed to the v1.2 token pass in the 9b review. The
queue rows reuse the same avatar and inherit it.

## Regenerating

The Inbox's states are live: which row is selected, whether the reasons are
open, and — for empty — that every row has been worked. `design-shots.mjs`
drives them by clicking rows and buttons found by their test ids and copy, so
a renamed button fails loudly rather than shooting the wrong state.

```sh
# one shell: the app on a stable database
DEV_USER_EMAIL=ben@relay.test npm run dev -- --port 5209

# another: the capture, Inbox states only
MOCK=file:///path/to/2026-09-07-shell-mock-signed.html \
APP=http://localhost:5209 \
OUT=docs/design/task-9d \
ONLY=inbox \
CHROME=/path/to/chrome-or-chromium \
node scripts/design-shots.mjs
```

`MOCK` is required: the signed mock lives outside this repository. `ONLY`
filters the states by id prefix; without it every state the script knows is
produced, which is what a shell task wants and this one does not.
