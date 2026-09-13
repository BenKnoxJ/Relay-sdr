# Task 19: What Relay learned

The campaign Overview (task 18) shows the decision-sized part of a finished research pack. This page, `/campaigns/[id]/research`, shows the rest. It is one scrollable page in eleven anchored parts, reached from the Overview's **What Relay learned →** and leading back with **← Back to the campaign**.

It is a view over the stored pack. There is no new agent, no model call and no second reading. `src/lib/campaigns/research.ts` builds it from the pack, and anything the Overview also reads goes through the same selectors in `src/lib/campaigns/packSelectors.ts`: which group ranks first, the lead angle, whose words are whose, the source count, the example firms, the gaps and the contradictions. The two screens differ in how much they show, never in what it means.

## Where each part comes from

| Part | Read from |
|---|---|
| The market and why now | Why this market (m00 spine); a timeline of the dated events (m13), with each dated trigger (m01) under the event of its day or on its own; coming dates (m01 next six months) that are not already on the timeline; parts of the market with their fit (m01); how big it is (m01); what is published about it and who shapes it (m01), behind a Show |
| Who to target | Research's view of the ideal customer (execSummary); each kind of buyer in rank order (m03 and m16): situation, size, the pain that dominates, its own reason and when it is the wrong call, who runs, champions and signs it, and what a deal might look like; the ideal company and buyer and who is not a fit (m08); the hard boundaries (m00), once |
| Pains and buyer language | Each group's pains, most acute first (m05); its buyers' own words (m06, buyers only); other people's words kept apart, each named as the regulator's, a supplier's or a trade body's |
| What to say | How to position it (execSummary); each group's angles ranked, the Overview's lead first (m16, m09); do and don't, lines from the sources and words to use (m09) |
| What we can answer and prove | How the product answers each pain, pointing at the pain by number (m07); pains it can't answer (m07); objections and answers, "Not available today" where research says so (m11); proof the rep may use (m15); **Don't claim** in one place: don't lead with (m00), what the product doesn't do (execSummary), how not to say it (m09), what not to imply for each capability (m07) and any proof that may not be used (m15) |
| Competition | Where the product stands (execSummary); if they do nothing (m02); each competitor's positioning, price where research found one, strengths and weaknesses behind a Show, and dated recent moves (m02); prices side by side and what else is in the picture, behind a Show |
| Example companies and targeting | Research's example firms by group, with why each fits and its size as research knows it (m04); how to find more like these behind a Show: the search, signs a firm is ready and lists to start from (m04) |
| Where buyers gather | Events, associations, publications, communities and review sites (m10); a dated one already on the timeline says "on the timeline" and links to it; where buyers look for tools (m02) |
| Contact rules | Each channel's rules as research found them (m12); a rule that restricts the channel is outlined in the warning colour and says so, and the channel's heading counts them |
| Gaps and contradictions | Everything research couldn't settle (m18) and everything that argues against the case (m17), grouped by what it means: Ask on the first call, Conflicting evidence, Careful what you claim, Relay couldn't verify, Pages Relay couldn't read. Each keeps why it matters, the question to ask and what a contradiction means; the searches are behind "Show what Relay searched" |
| Sources | Every source (m19), numbered, by title and site, with the day it was read. The url is only where the link goes |

The line under the title reads "78 sources · researched 13 Sep 2026", both from m19.

## What is shown once

- A trigger dated the day of an event sits under that event ("2 also reported that day"). Research reported the FCA's statement of 18 December 2025 as one event and two triggers, and it is one entry.
- A coming date is not repeated when the timeline already has an event on that day. Three of the five next-six-months lines are events; two are shown as "Also expected".
- A hard boundary is shown once. m08 echoes m00's filters word for word, and each group's echoed boundaries (m04) are already a boundary or a Don't claim, so none is repeated.
- Don't claim holds every constraint once; a capability's limit is shown there, not beside the capability.
- A line from the sources repeated for a second group is shown under the first.
- A group's lead angle is the Overview's; the m03 opening angle, which restates it, is not shown again.

In each part about the kinds of buyer (who to target, pains, what to say, answer and prove, example companies), research's rank-1 group is open and the others open in place. A link to a pain in a closed group opens it.

## Internal names

Research sometimes names its own parts and facts in a sentence. On this page:
- a fact id in brackets is dropped;
- "Facts file items …" reads as "Relay's facts about the product";
- a part named by its id reads as the part of the page that shows it ("the contact rules in ‘Contact rules’");
- "archetype" and "persona" read as "kind of buyer" and "role".

Nothing else in research's text changes.

## A run cut short

A partial pack draws every part it can. A part whose sources were not written says "Relay ran out of time before it wrote this part." One with some of them missing names them. Nothing is filled in. With no campaign ranking (m16) no group is ranked or given a lead. With no source list (m19) the count falls back to the urls research cited, as the Overview's does. Only a finished plan has this page; a campaign still researching, stopped or needing the rep is sent back to its own page.

## Shots

Taken from a throwaway local database seeded with the sanitised smoke fixture (`fixtures/research/smoke-a-insurance-direct-2026-09-13.json`), never the live pack: the live pack names the people it quotes. In each part about the kinds of buyer, research's rank-1 group is open and the others are closed.

| Shot | Shows |
|---|---|
| `research-1440-light-top.png` | The top of the page on desktop, every Show closed: title, sources line, Jump to, why this market and the timeline |
| `research-390-light-top.png`, `research-390-dark-top.png` | The top of the page at phone width: title, sources line, Jump to, and the start of the timeline |
| `research-1440-market-timeline.png` | The timeline, with one event's "also reported that day" open |
| `research-1440-who-group.png` | A kind of buyer, with what a deal might look like open |
| `research-1440-pains-group.png` | A group's pains, its buyers' words, and the regulator's kept apart |
| `research-1440-dont-claim.png` | Don't claim |
| `research-1440-companies-group.png` | Example firms, with how to find more like these open |
| `research-1440-contact.png` | Contact rules, with the three that restrict a channel |
| `research-1440-gaps.png` | Gaps and contradictions, with what Relay searched open |
| `overview-link-1440-light.png`, `overview-link-390-light.png` | The Overview's way in |
