# Task 9e — design conformance

The signed mock beside what this branch renders, one image per Settings
state. Phase 1 plan, conformance guard 1: *"A page without this comparison is
not reviewable."* Neon reviews a divergence from the mock or the tokens as a
finding with a severity, never a preference; Benny-san signs each page on
sight.

| Image | State | Reference |
|---|---|---|
| `settings.jpg` | The four cards as the page lands: Mailbox (Task 10b), LinkedIn, Your voice folded at three rows, Calls | mock section 5, master doc §23.1f (1) to (4) |
| `settings-voice-open.jpg` | Your voice unfolded to all seven, with the Add box open | mock section 5 ("… 4 more · Add an email you are proud of"), §23.1f (3) |
| `settings-refused.jpg` | A link that is not a profile link, and a note over ten lines, each refused on the card's own line | §23.1f (2) and (3), §22.4 plain words; the mock draws no refusal |
| `settings-focus.jpg` | The Calls switch with focus on it, both themes | WCAG 2.4.7; the mock draws no focus state |

Light and dark are both shown because the palette switches on one attribute
and nothing else, so dark is where a hard-coded colour surfaces. The page is
shot at 1560px tall so all four cards are in the frame; the shell's other
pages are shot at 760.

## Known divergences from the mock

Each of these is a deliberate choice of the signed **tokens**, the master
doc's words, or the fixture's shape over something that appears only in the
mock's own drawing. They are listed so the review rules on them rather than
discovering them.

1. **The Mailbox card is Task 10b's and is not restyled here.** Its own
   divergences (the connection line, the cap's wording, the four rows) were
   ruled on in PR #12; this branch does not touch it.
2. **The LinkedIn field shows the whole link.** The mock draws
   `linkedin.com/in/benknoxjohnston`; the field holds what the rep pasted,
   `https://www.linkedin.com/in/benknoxjohnston`, because that is what is
   saved and what a draft will use, and a field that shows one thing and
   holds another is a surprise on blur (§22.5).
3. **The row's grey line is words and the day, not the recipient.** The mock
   writes "to Brightline · 412 words"; the fixture shape §23.1f fixes carries
   the pasted text and the day it was added and no recipient, so the line is
   "93 words · added 14 Aug". The recipient returns if the repository ever
   carries one.
4. **The word counts are the fixture's.** The mock's 412, 96 and 138 are
   the mock's; the built rows count the pasted text.
5. **The fold is a button that says what it does.** The mock draws "… 4 more"
   as text on the Add line; the built page makes it a control with
   `aria-expanded`, "Show 4 more" then "Show fewer", because a rep has to be
   able to reach the other four, and a screen reader has to be told the list
   opened.
6. **Add opens a box; the mock draws no box.** The pasted email goes into a
   labelled textarea with Add and Cancel under it. Add is the card's one
   primary control (§21) and exists only while the box is open.
7. **"Saved" is not shown on the page as it lands.** The mock draws "Saved"
   in every heading as a sample of the state; the built line is empty until
   something is saved, and then says "Saved", "Added" or "Removed". An
   always-mounted, empty `role="status"` carries it (the `DailyCapField`
   pattern), so the word is announced when it appears.
8. **The Calls switch saves on change, not on blur.** §23.1f says "saves on
   blur"; a switch has no blur to save on, so the click is the save and the
   same quiet "Saved" says so.
9. **The note is a textarea with a hint, "Ten lines at most."** The mock
   draws the note as a box of prose; the built one is editable, wraps as
   typed, and refuses an eleventh line on blur with the count said plainly.
10. **Type sizes are the scale's.** The mock's heading aside is 11px mono at
    weight 500 and the row meta 12px; both are on the signed scale and are
    used as drawn. Nothing else on the card is off-scale.

## Carried, not fixed here

The avatar's initials are `text-action` on `bg-soft` (4.33:1 in light), the
9a `soft`-as-text gap routed to the v1.2 token pass in the 9b review. The
switch's knob when off is `bg-muted` on `bg-ground`, which is a control and
not text; it is listed so the review can rule on it.

## Regenerating

Settings' states are live: which rows are folded, whether the Add box is
open, and, for the refusals, that a field was changed and left.
`design-shots.mjs` drives them by the copy file's button text and by
sending the fields the `input` and `focusout` events React listens for, so
a renamed button fails loudly rather than shooting the wrong state.

```sh
# one shell: the app on the dev database, on a free port
DEV_USER_EMAIL=ben@relay.test npm run dev -- --port 5210

# another: the capture, Settings states only
MOCK=file:///path/to/2026-09-07-shell-mock-signed.html \
APP=http://localhost:5210 \
OUT=docs/design/task-9e \
ONLY=settings \
CHROME=/path/to/chrome-or-chromium \
node scripts/design-shots.mjs
```

`MOCK` is required: the signed mock lives outside this repository. `ONLY`
filters the states by id prefix; without it every state the script knows is
produced, which is what a shell task wants and this one does not.
