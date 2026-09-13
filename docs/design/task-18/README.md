# Task 18: a truthful campaign Overview

The first live research run through the app (the smoke test of 2026-09-13, brief A) came back complete. The campaign page then showed about a fifth of the pack, and three of its five card summaries sat under the wrong heading.

A real campaign's finished plan is now the **Overview**, in six parts. Each part is a lookup into the stored pack through `src/lib/campaigns/packSelectors.ts`; nothing is reworded:

| Part | Read from |
|---|---|
| In short | The rep summary's five lines, one statement each under a scan label (Who, Why now, Opening, Biggest unknown, Opportunity), and research's view of the market; the source count from the pack's own sources |
| Start with | Research's rank-1 campaign: the group, the lead angle (looked up when named by id), its own dated reason, and when it is the wrong call |
| Buyer groups | The four kinds of buyer, ranked as research ranks the campaigns: size, and who runs it, champions it and signs it off. No people found |
| Pains and buyer language | The rank-1 group's first two pains and one of its buyers' own phrases; "Show all pains and language" opens the rest, with a regulator's or supplier's words only under their own label |
| Example firms | The eight firms research sized, with their group and their size as research knows it; an unknown size says so |
| Check first | The biggest unknown and the first three questions to ask on the first call, in research's order. "Show all questions Relay recommends asking" opens the rest; "Show everything Relay couldn't settle" opens every gap and everything that argues against the case as separate findings, with each link shown as its host |

The plan cards stay for the sample campaigns, which draw the states that need lead gen first. Research's own code and contract are unchanged.

| Shot | Shows |
|---|---|
| `overview-1440-light.png` | The smoke-test campaign on desktop |
| `overview-390-light.png`, `overview-390-dark.png` | At phone width: the Overview stays inside the column (296px); only the deferred top nav overflows |
| `overview-390-light-open.png` | Every "show" open at phone width: still no url on screen and nothing wider than the column |

The first page's two raw links in the gaps summary widened the plan to 745px at a 390px width. That no longer happens.
