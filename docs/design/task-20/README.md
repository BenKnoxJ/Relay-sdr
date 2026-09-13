# Task 20: the Campaign Research Pack (print / save as PDF)

"What Relay learned" as a document. The rep presses **Print / save PDF** on the research page, and the browser's own print dialog opens. From there they print the pack or save it as a PDF to share inside their company. It is internal only: every page after the cover says so.

There is no new data, no new reading of the research, no model call, no server endpoint and no stored file. The pack is drawn from the same stored research, through the same code, as the page.

## How it works

- **One set of parts, two layouts.** The eleven parts of the research page (`SECTIONS` in `ResearchPage.tsx`) take a `Kit`, which says how a part and the lists inside it are laid out.
  - The page uses `WEB`: each part closed, with "View …", "Show …" and groups that open in place.
  - The pack uses `PRINT` (`ResearchReport.tsx`): each part on its own page with its number and title, what it holds (the same counts as a closed part's preview), and everything inside it set out in full, with nothing to open.
  - The research, the selectors and the rules about what is shown are shared. Only the layout differs.
- **The pack is on the page from the start.** It is drawn beside the page by the route and shown only on paper (`hidden print:block`), while the page and the app's nav are hidden on paper (`print:hidden`).
  - So printing needs nothing opened first, and changes nothing on screen.
  - Whatever the rep has open or closed, the pack is whole, because it has nothing to open.
  - Cancelling the dialog leaves the page exactly as it was.
- **The button** calls `window.print()` and nothing else. While the dialog is open, the document's title is "<campaign> · Relay Campaign Research Pack", which is the name a browser gives the saved PDF. The title is put back when the dialog closes, including for a print started from the browser's menu.

## What the pack holds

1. **Cover.** It carries:
   - the Relay mark (the nav's gradient square and wordmark);
   - "Campaign Research Pack";
   - the campaign's name, and who to reach in the rep's own words;
   - product, motion, where, channels, the date research read its sources, and the pack's own source count;
   - the eleven parts, numbered (in the PDF they are links);
   - how to read the pack (what the four confidence words are);
   - the classification, "Internal: not for prospects", and why.
2. **At a glance.** The Overview's In short (the five scan lines and Relay's view) and Start with, as the campaign page shows them. They are the same values, from the same selectors, not read again. A partial pack says here which parts are missing. A pack with no rep summary or no ranked campaign simply has less here.
3. **The eleven parts, 01 to 11.** Each starts a page.
   - Groups are marked down their left edge so each reads as its own.
   - Don't claim, contact rules that restrict a channel, and gaps keep their warn framing and their words ("Don't claim", "Restricts this channel", "Ask on the first call"), so none relies on colour.
   - Competition keeps its cards (strengths and weaknesses in two columns on paper) and the price table.
   - Sources is the appendix: every source, numbered, with its title, host and the date read, and the full address in small type under it (on paper a link cannot be followed).

What the page keeps a click away is all in the pack:
- every group;
- deals;
- also reported that day;
- strengths and weaknesses;
- prices;
- how to find more;
- signs, lists;
- every source.

One thing is left out on purpose: the searches research ran for a gap ("what Relay searched"). That is how research worked, not what it found.

## Paper

- A4, margins 16 / 16 / 18 mm.
- Footer on every page after the cover: "Relay · Campaign Research Pack · Internal: not for prospects". The page number, "Page n of N", is on the right.
- Browser margin boxes (`@page` `@bottom-left` / `@bottom-right`) are supported by Chromium 131 and later. The footer strings come from the copy file; nothing a rep or research wrote is put into a stylesheet.
- Empty top margin boxes, and empty bottom boxes on the cover, keep the browser's own header and footer (date, title, address) off the pack. They stay off even when the dialog's "Headers and footers" is ticked; this was checked in Chromium.
- `print-color-adjust: exact` on the pack keeps its tints when background graphics are off. Nothing depends on them: every caution is also a border and a word.
- Headings stay with what follows them; paragraphs keep at least three lines together. Small items (a finding, a rule, a firm, a segment, a source, a row) do not split across pages. Long ones (a competitor, a group, a timeline entry) may, rather than leave half a page empty.
- Nothing wider than the page: the pack wraps anywhere, source addresses wrap, and the price table drops its screen minimum width.

## Evidence

From a throwaway local database seeded with the sanitised smoke fixture (`fixtures/research/smoke-a-insurance-direct-2026-09-13.json`), never the live pack. The partial pack is the same fixture with five parts taken out, as a rail would leave it (competitors, their own words, contact rules, campaign ideas, what Relay couldn't find).

The PDFs were printed by Chromium 151 over the DevTools protocol (`Page.printToPDF`, the page's own paper size, background graphics off), with every part on the page closed.

| | Complete pack | Partial pack |
|---|---|---|
| Pages | 67 | 60 |
| File size | 1.20 MB | 1.03 MB |
| Parts start on page | 3, 11, 18, 24, 29, 36, 42, 50, 55, 57, 62 | 3, 11, 18, 23, 29, 36, 37, 45, 50, 51, 55 |
| Widest text on any page | 550.6 of 595 pt (inside the right margin) | 550.6 of 595 pt |

- While printing, the page made no request, its eleven parts stayed closed, and its address and scroll were unchanged.
- The button called `window.print()` once, and the title was restored.
- In both PDFs' text there is no email address, no personal profile, no internal address and none of the names the fixtures once held.

| Shot | What it shows |
|---|---|
| `research-1440-print-action.png`, `research-390-print-action.png` | The research page with Print / save PDF, on a wide screen and a phone |
| `research-1440-after-print.png` | The page after printing: every part still closed |
| `pack-01-cover.png` | The cover |
| `pack-02-at-a-glance.png` | In short, Relay's view, Start with |
| `pack-03-market.png` | Part 01: the case, then the timeline, with the day's other reports set out |
| `pack-12-who-group.png` | Part 02: a kind of buyer, with its deal and roles |
| `pack-33-dont-claim.png` | Don't claim, in its warn frame |
| `pack-36-competition.png`, `pack-37-competition-cards.png` | Part 06: where the product stands, if they do nothing, competitor cards |
| `pack-55-contact.png` | Part 09: contact rules, with the ones that restrict a channel |
| `pack-57-gaps.png` | Part 10: gaps and contradictions. This part is closed on the page when printed. |
| `pack-62-sources.png` | Part 11: the source appendix |
| `pack-partial-02-at-a-glance.png` | A partial pack: which parts are missing, and no Start with (research ranked nothing) |
| `pack-partial-18-pains-unwritten.png`, `pack-partial-36-competition-unwritten.png` | Parts research did not finish, said as such |

## Limits of the browser print

- The page numbers and the footer need a browser that draws `@page` margin boxes (Chromium 131 and later). Another browser prints the pack whole, without them.
- The paper size is set to A4. A browser that honours the page's own size (Chromium) does not offer Letter.
- The pack is laid out for the light theme; Relay has no dark theme on screen today.
