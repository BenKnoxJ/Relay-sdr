# Relay agent definition — Outreach (v2, signed)
**v2 · SIGNED by Benny-san 2026-09-08 · supersedes v1 · audit: `reviews/2026-09-08-review-outreach-depth.md`**
Contract: master §7.3 Outreach, §15, §11, §22. Screens: Inbox draft, call and needs-you cards (§23.1b). The most important agent in slice 1.

What changed from v1, in one line: the audit showed Pitch's cohort was clean but invented (one PDF cited as evidence for 87 openers, a price quoted 97 times that no fact supports, a quarter of first emails with no question, templated phrases across the whole cohort). v2 puts the lookup, the fact-id validation, the reply guard, the ask and length gates, and a repetition check in code before the model's output can reach a queue.

## 0. Shape
One model call per draft, between two code layers: a bounded, injection-scanned lookup before it, and deterministic gates after it. The model writes; code decides what is true, what is allowed, and whether the draft is written at all.

## 1. Job, in one line
Write every message this rep sends in this campaign, one person and one touch at a time, in the rep's voice, on the day it is due, and hand it to the queue with its evidence.

## 2. Guard before anything runs (code)
No draft is written when: the person replied (any label), bounced, opted out, is held or suppressed, the campaign is paused or not Running, or the touch is not due today. The touch is closed with the reason. The same guard runs again in the send job at send time.

## 3. Inputs (per draft job)
```
person, touch{kind, ordinal, dueAt}, thread (earlier touches with fate and reply text), pack@briefVersion (matched archetype, pains, language, hook), facts (live ids only), voice{samples by register: email[≤8], linkedin[≤4], howIWrite}, standard@version (eight rules + exemplars), lookup: LookupResult
```

## 4. The lookup (tool step, before the model; typed, budgeted, scanned)
- Budget: 2 searches, 2 fetches, 90 seconds, replay keys on both; cost recorded on the draft.
- Queries: `"<first> <last>" "<company>"`, then `"<company>" <two trigger words from the pack>`.
- Returns `LookupResult{ items: LookupItem[≤3] | none }`, `LookupItem = Item` from the research contract (id, text, quote?, publishedAt, evidence{urls}, confidence derived) with `about: "person"|"firm"`.
- **Usable** = dated within 12 months, about this person or firm, from a stored page, with a six-word quotable span or a citable number. Inference from firm type is never usable (the Pitch failure).
- Fetched text is injection-scanned before the model sees it; nothing from a page is an instruction.

## 5. Output (schema `Draft`)
```
subject?:  string                       // email touches; concrete noun phrase, 20–50 chars, no fake "Re:"
body:      string
opener:    { ref: LookupItemId | ArchetypePainId, kind: "person_fact"|"archetype_pain" }   // provenance by id; the card renders text and source from the referenced item
claims:    FactId[]
ask:       string                       // the one question; must appear verbatim, once, as the last sentence
```
Limits by touch: email1 50–150 words · email2 ≤ 100 and shorter than the previous · breakup ≤ 60 with a clean out · li_connect ≤ 300 chars (Premium) else ≤ 200, no link, no pitch · li_dm 50–80 words, no link · call → `talkingPoint{ openingLine ≤ 25 words, oneQuestion, listenFor, numberSource: "zoho"|"switchboard"|"find_a_number" }`.

## 6. Writing rules (the prompt's spine; the standard's eight rules are the law)
1. Open on the opener's referenced item in one sentence. No preamble, no pleasantry.
2. One pain, from the lookup item or the archetype. Never two.
3. At most one product claim in email 1, by fact id, honouring the fact's notes (what must not be over-claimed); follow-ups may carry none.
4. One question, last sentence, and it is the `ask`.
5. British English; the banned lexicon is injected as a list; no em dashes; no bullets in emails.
6. Voice from the register's samples: sentence length, warmth, sign-off; never a sample's content.
7. Follow-ups anchor on the person's own earlier touch, not the campaign template, and shrink.
8. No phrase reuse: the model receives the person's earlier touches and the campaign's last twenty openers with the instruction to avoid their phrasing (the gate in §7 enforces it).

## 7. Gates (code, after the model; pure functions, findings in rep words)
**Tier A, reject and redraft the failing touch only, with findings, max two, then `needs_you` with the reasons:**
banned lexicon (hashed snapshot from the wiki) · length per touch and "shorter than the last" · ask present exactly once and last · `opener.ref` exists and, for `person_fact`, its item is `usable` · every `claims[]` id exists, is `live`, and its number (if any) appears in the body · a number in the body that traces to no fact or lookup item · em dash · non-British spellings from a fixed list · **repetition**: 5-gram overlap with the person's earlier touches > 20% (A) · humaniser Tier A patterns.
**Tier B, advice on the card, never blocks:** subject shape · repetition against the campaign's last 20 drafts (B) · humaniser Tier B · fewer than two concrete nouns · stacked hedges.
The humaniser flow is stated once: the agent runs the humaniser skill and these same gates before it finishes; the ingest gate is the judge; two Tier A rejections park the draft as `needs_you` with the labels shown on the row.

## 8. When drafts are written
On the day the touch is due, never up front. §2's guard runs before writing and again at send. Facts are re-checked at send against the facts version current that day; a claim whose fact is no longer `live` returns the draft to the queue as `needs_you(wrong_fact)`.

## 9. Reject reasons and their consequences (from the card, §23.1b)
`wrong angle` → redraft on a different pain from the archetype · `wrong person` → close the person's remaining touches, record for lead gen's scoring · `wrong fact` → mark the lookup or pack item bad, redraft on the archetype pain · `not now` → snooze the touch 14 days. A rewrite request never cancels the person.

## 10. Quality loop capture (§11)
Every approve, edit (before and after, diff classified deterministically: trim, reword, rewrite, factual), reject with reason, reply label and call outcome is an Event on the draft. Override rate (approved with a Tier B line) and edit classes surface in the weekly review. **No gate tightens on gate evidence alone**: ten real sends with replies before any rule changes.

## 11. Cost
Lookup + draft + gates under $0.08 per email touch, recorded per draft; a per-campaign ceiling (default $10) parks further drafting as `needs_you(cost_cap)`.

## 12. Rubric (sign-off gate on the bench)
| # | Check | Pass |
|---|---|---|
| 1 | Guard | fixtures for replied, bounced, opted out, paused, not due: no draft written, touch closed with reason |
| 2 | Schema and claims | 30 fixture drafts validate; every claim id live; a dead or planned id rejected; a body number with no fact rejected |
| 3 | Opener honesty | `usable: false` → archetype opener and "no person fact" on the card; no proper noun in the opener absent from lookup or pack |
| 4 | Ask and length | 100% of drafts have exactly one question, last; follow-ups shorter than the last; LinkedIn and call shapes within limits |
| 5 | Repetition | seeded reuse of an earlier touch's phrasing is rejected; cohort-level reuse is flagged Tier B |
| 6 | Swap test | 10 drafts, name and company swapped, opener false in ≥ 9 (model oracle, tests only) |
| 7 | Voice | blind pairwise, Benny-san picks Relay over generic ≥ 7 of 10 |
| 8 | Gates seeded | em dash, hype word, two asks, dead fact, 180 words, fake "Re:", non-British spelling: each rejected with the right finding; a clean draft passes |
| 9 | Redraft | Tier A rejection redrafts the failing touch only with findings, passes second time ≥ 8 of 10; two rejections → needs_you with labels |
| 10 | Lookup bounds | never more than 2 + 2; replay makes zero new calls; injection fixture stripped and logged |
| 11 | Reject consequences | each of the four reasons produces its §9 effect |
| 12 | Words | `assertPlainWords` on body, reasons, talking points |
| 13 | On screen | ten drafts on the Approve card, evidence line from the referenced item, a needs-you row with labels, a call card; eyeballed |
| 14 | Cost | under $0.08 per email touch; campaign ceiling parks drafting |

## 13. Master amendments this implies (applied on signing)
- §7.3 subject rule "36 to 50 characters" → "concrete noun phrase, 20 to 50 characters, no fake Re:" (Pitch's best subjects were 21–39; 36–50 would have failed them). Tier B, not blocking.
- §7.3 Outreach gains the lookup contract, the reply guard and the reject-reason consequences by reference to this file.
- §23.1b reject reason `wrong fact` consequence stated.

## 14. Deliberately not here
Sending, the Zoho upsert (send job), reply drafting (1b), learned voice (H2), phone buying (never).

## 15. Resolved from v1's open questions
1. Samples split by register and capped per prompt (email ≤ 8, LinkedIn ≤ 4). 2. The swap-test oracle is tests only. 3. Email 1 may carry zero product claims when the pain and ask carry it.

# Relay agent definition — Outreach (v2.1, signed)
**v2.1 · SIGNED by the product owner 2026-09-15 · amends `outreach.v2.signed.md`; where the two differ, v2.1 wins**
Inputs: the Email 1 quality audit (`ops/design/2026-09-15-relay-outreach-v2-quality-audit.md`), accepted by the product owner on 2026-09-15 with three corrections written into the text below: the redraft limit, cohort repetition, and whole-body provenance.

## 1. Scope
The first implementation writes `email1` only. The other touches stay as signed in v2 and are not built. Nothing is sent in this slice: an approved draft is Ready to send.

## 2. Inputs (extends §3)
- `person`: Relay's revealed Person: name, first name, title, company, domain, work email.
- `buyerRole {id, part: runs|champions|signs, title, needs}` from the person's campaign row; absent for a Related role.
- `account {company, domain?, seedEvidence?}`.
- `pack` adds, for the confirmed archetype: m09's top angles, its do/don't lines and verbatim phrases, and m15 proof items marked `allowed` only.
- `recentDrafts` replaces `recentOpeners`: the campaign's last twenty drafts' opening sentences, asks and subjects, each marked when it is at the same account.
- `redraft {findings, previous}`, on the one corrective redraft only.
- The greeting and the sign-off are the envelope. The model writes neither.

## 3. Lookup (amends §4)
- The 2 searches and 2 fetches are a maximum, not a quota.
- Person evidence first. If nothing genuinely useful, account evidence. If nothing again, no further call: the role problem is used.
- The lookup stops as soon as a usable, relevant item exists.
- `usable` also requires relevance to this person's role or to a pack pain, and that the item is about their professional role or their firm, never their personal life.
- A person item is Tier 1 and a firm item is Tier 2.

## 4. Output and shape (amends §5)
- `opener.kind` is `person_fact | firm_fact | role_pain`. `archetype_pain` is read as `role_pain`. A `role_pain` ref resolves to an archetype pain, the hook, or the buyer role.
- `body` is the message between the greeting and the sign-off. Sender identity and the opt-out are added at send.
- Email 1:
  - the body is 40 to 110 words, aiming for 50 to 90;
  - 3 to 5 sentences;
  - paragraphs of at most 3 sentences.
- Subject: 2 to 6 words, at most 45 characters, advisory. This replaces "20 to 50 characters".

## 5. Writing rules (amends §6)
- **Rule 1:** state the reason for writing in the first sentence, from the opener's item or the role problem, in plain words. No preamble.
- **Rule 3 adds:**
  - no social proof, customer names, prices or ROI unless a live allowed proof item or a live fact supports it;
  - no claims about the sender's experience, conversations or other customers.
- **Rule 4:** one question, last, and it is the `ask`. It is an interest or relevance question, never a specific time, a meeting length or a calendar link. No links in Email 1.
- **Rule 8 extends** to the campaign's recent drafts: their opening frames, asks and distinctive sentences.
- **Rule 9:** write to this role's needs.
  - Runs it: the working problem.
  - Champions it: the evidence they lack.
  - Signs it off: the outcome and the risk, shortest.
  - Never mention a colleague.
- **Humaniser principles are part of the prompt:** subtractive; never add a fact, claim, number or anecdote; no set-up sentences, rhetorical contrast, lists of three, fake empathy or marketing adjectives.

## 6. Gates (amends §7)
- **Generations:** an initial generation, then at most one corrective redraft with the findings, then Needs you. At most two model generations per draft.
- **Tier A adds:**
  - a time or meeting ask, a meeting length or a calendar link;
  - any link in Email 1;
  - an exclamation mark;
  - the two-sentence antithesis ("isn't X, it's Y"; "not X. It's Y.");
  - the short tell list, including sender-experience and false-familiarity phrases;
  - **provenance:** every externally factual named entity and every number the model introduces resolves to the lookup, the pack or live facts. The structured values the input already carries (the person, their company, the product, the rep, buyer-role terms) are valid. This is not a capitalised-word detector;
  - **cohort template repetition:**
    - an opening frame near-identical to two or more of the campaign's drafts, or to any draft at the same account;
    - an ask identical, after normalising, to one already used twice, or once at the same account;
    - a distinctive sentence near-identical to one in two or more of the campaign's drafts, or one at the same account.
- **Generic n-gram or body similarity across the cohort is advisory (Tier B),** unless it is one of the duplicated frames above.
- **The lexicon** is a short, high-precision tell list versioned in the repo with the message standard. It replaces the hashed wiki snapshot.
- **Tier B** drops "fewer than two concrete nouns", and adds reading level and lists of three.
- **The humaniser** is its principles in the prompt plus these deterministic gates. There is no separate model humaniser pass.

## 7. Measures (extends §10)
- Delivered, bounce and reply.
- Positive reply (warm), and a conversation or meeting booked (rep-marked).
- Negative reply, stop and unsubscribe.
- No open tracking.

## 8. Rubric (amends §12)
- **Row 4:** Email 1 is 40 to 110 words.
- **Row 9:** a Tier A rejection redrafts once, with findings; a second failure goes to Needs you with the labels.
- **Role differentiation:** at one account, the drafts for the three roles differ in problem and ask; a blind reviewer names the role in at least 2 of 3.
- **Cohort:** 20 drafts in one campaign. No opening frame or distinctive sentence appears in 3 or more; no ask is used more than twice.
- **No invention:** a seeded irrelevant or personal lookup item gives a `role_pain` opener; a seeded invented entity or number is rejected.
- **Sendability:** the product owner scores 20 drafts against the seven-question test. At least 16 are sendable as they are or with light edits, and 0 contain invented statements.

## 9. Master edits implied
- §7.3: "50 to 150 words" becomes "Email 1: 40 to 110 words".
- §15: "one humaniser skill" becomes "the humaniser gate (code) and its principles in the prompt".
