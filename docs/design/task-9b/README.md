# Task 9b — design conformance

The signed mock beside what this branch renders, one image per signed state.
Phase 1 plan, conformance guard 1: *"A page without this comparison is not
reviewable."* Neon reviews a divergence from the mock or the tokens as a
finding with a severity, never a preference; Benny-san signs each page on
sight.

| Image | Signed state | Reference |
|---|---|---|
| `home-day-one.jpg` | Home on day one: one card, the brief box, connect prompts | mock section 1b, master doc §23.1a |
| `content-coming.jpg` | Content before its slice | mock section 6, §23.0 |
| `inbox-empty.jpg` | Inbox with nothing waiting | mock section 2c, §23.1b |
| `campaigns-empty.jpg` | Campaigns before there is one | mock section 3a (drawn populated), §23.1c |
| `settings.jpg` | Settings: the four cards, contents from Task 10b | mock section 5, §23.1f |
| `nav-roles.jpg` | The nav as an admin and as a rep | §23.0 |
| `home-dark.jpg` | Home in dark | mock section 6 |
| `home-focus.jpg` | The brief box with focus in it, both themes | WCAG 2.4.7; the mock draws no focus state |

Light and dark are both shown because the palette switches on one attribute
and nothing else, so dark is where a hard-coded colour surfaces.

## Known divergences from the mock

Each of these is a deliberate choice of the signed **tokens** over a number
that appears only in the mock's own stylesheet. They are listed so the review
rules on them rather than discovering them.

1. **Empty-state paragraph width.** The mock caps it at `44ch`; this uses the
   tokens' `bodyMaxWidth` (`65ch`, `max-w-measure`), so the paragraph is wider
   and runs to fewer lines. There is no 44ch token.
2. **The wordmark's gradient.** The mock draws a two-stop 135° violet-to-orange
   split; this uses the signed `gradient` token (90°, three stops), which is
   the one the tokens file names.
3. **The wordmark's radius.** The mock says 7px; this uses `rounded-sm`, which
   is `calc(var(--radius) - 8px)` = 8px, derived from `radius.card`.
4. **Campaigns.** The mock only draws the populated list. Day one has no rows,
   so the page is the empty state; the list itself arrives with slice 1.
5. **Settings.** The mock draws all four cards filled in. Their contents belong
   to Task 10b and the tasks after it; the shell ships the cards and their
   signed headings.
6. **Home's connect prompts.** The mock's 1b frame does not draw them; the
   master doc (§23.1a) says day one carries one line per connection that is
   not yet made. The doc wins. Endorsed by Neon in review `5147636443`.
7. **Inbox's empty copy.** The mock's empty frame says less than the built page
   does; §22.7 asks an empty state to say what happens next rather than that
   there is nothing. Endorsed in the same review.

## Carried, not fixed here

The avatar's initials are `text-action` on `bg-soft`, which measures 4.33:1 in
light — under the 4.5:1 floor the signed tokens set (WCAG 1.4.3; dark clears at
~4.74). This is the 9a `soft`-as-text gap with a rendered instance, not a
defect in this branch, and Neon routed it to the **v1.2 token pass**: the fix
is to deepen light `soft`, which keeps the violet-on-violet the mock draws.
Changing it here would spend a token decision inside a shell PR.

## Regenerating

`home-focus.jpg` is the built page against itself: it needs no mock pane,
because the signed mock draws no focus state.

`nav-roles.jpg` needs the same page rendered for two different people, so the
capture wants two instances: one signed in as the org's admin, one as a rep.
The first person to sign in with a given email domain is that org's admin and
everyone after them is a rep, so two addresses on one domain is all it takes.

```sh
# one shell: the admin
DEV_USER_EMAIL=ben@relay.test  npm run dev -- --port 5200

# another: a rep in the same org
DEV_USER_EMAIL=sam@relay.test  npm run dev -- --port 5201

# a third: the capture
MOCK=file:///path/to/2026-09-07-shell-mock-signed.html \
APP=http://localhost:5200 \
REP_APP=http://localhost:5201 \
OUT=docs/design/task-9b \
CHROME=/path/to/chrome-or-chromium \
node scripts/design-shots.mjs
```

`MOCK` is required: the signed mock lives outside this repository. `REP_APP` is
optional — without it the other seven images are produced and `nav-roles.jpg`
is skipped, with a line saying so.

`scripts/design-shots.mjs` drives whatever Chrome or Chromium is on the machine
over the DevTools Protocol, so it adds no dependency to the project.
