---
title: Insights360 — Ideal Customer Profile
topic: insights360
author: research team
last_verified: 2026-05-18
status: live (baseline) — sector-specific archetypes populated per campaign
---

# Insights360 — Ideal Customer Profile

> **Owner:** the research team (per-product). This file is the **product-level
> baseline** ICP. Sector-specific archetypes (UK legal, German
> finance, US healthcare, etc.) are produced per campaign as
> the research team pack Module 1 and live in the campaign handoff, not here.

## Primary buyer roles

These are the personas Insights360 is built for. Drawn from the
product's persona definitions (`projects/insights360/CLAUDE.md`) and
website positioning.

| Role | What they want from Insights360 | Where they live in the product |
|---|---|---|
| **QA Manager / QA Analyst** | Replace manual sampling (2–5% of calls) with automated scoring across full call volume. Rule failure pattern analysis. Self-serve QA rule configuration. | `/qa`, Settings → QA Rules editor, `/call/[id]` |
| **Compliance Team** | Audit trail across 100% of recorded calls. Risk flag taxonomy that maps to their regulatory framework. Evidence on demand. | `/risks`, audit log, Settings → Risk Types |
| **Contact Centre Manager** | Volume + quality at a glance. Anomaly callouts. Period-over-period comparison. | Dashboard |
| **Operations Director** | Margin-defensible pricing. Proof QA review time reduced. Agent performance trend data. | Dashboard, Agent leaderboard |
| **Team Leader** | Coaching prompts with call-level evidence. Filter to their team. Bottom-performer identification. | `/team/[id]`, `/agent/[name]` |
| **Customer Success Manager (Conversant-side)** | Churn signals at the call level. Sentiment trends per customer. | `/risks` filtered by Customer Satisfaction |

**Agents** are not buyers or current users — agent-facing UI is in the
roadmap (Theme 5). Do not target outbound at agents.

## Company profile (the buyer's organisation)

- **Sector:** any organisation operating a contact centre with
  recorded calls. Notable concentrations expected in: regulated
  industries (legal, financial services, healthcare, utilities),
  customer-service-led businesses (insurance, telecoms, retail),
  outsourced BPOs.
- **Size:** **5 to 250 contact-centre seats**. This is the sweet spot
  where manual QA is insufficient but enterprise tools are
  unaffordable.
- **Geography:** UK primary (Conversant is UK-headquartered, hosting
  is UK/EU, ISO certifications are UK). EU secondary. North America
  inbound only via existing relationships, not active outbound focus
  in v1.
- **Telephony stack:** any of the 8 compatible platforms (Microsoft
  Teams, 3CX, Cisco, Avaya, Mitel, 8x8, Five9, RingCentral). Currently-
  wired integrations skew to 3CX users and OAK (Conversant's own
  platform) — see `roadmap.md`.
- **Buying committee size:** usually 2–4 stakeholders. QA/Compliance
  champion + Operations sign-off + Finance/IT review. Not enterprise
  RFP committee scale.

## Pain points (product-level, baseline)

These are the durable, cross-sector pains Insights360 addresses.
Per-campaign confidence-tagged sourced pain data is the research team's job per
sector.

- **Coverage blind spot.** Manual QA covers 2–5% of calls. The other
  95% — escalations, complaints, compliance-adjacent conversations —
  is invisible to the QA team.
- **Enterprise tools priced out of reach.** £40–£160 per seat per
  month with 50-seat minimums and annual commitments. Inaccessible
  below ~50 seats and economically painful below ~200.
- **Manual QA is inconsistent.** Different reviewers, different scores
  on the same call. No calibration. No audit trail of why a score was
  what it was.
- **Compliance risk hides in the unreviewed 95%.** Mis-selling,
  data-handling breaches, regulatory misstatements — every one a
  fine waiting to be found.
- **Coaching is anecdotal.** Team Leaders coach on vibes, not
  evidence. No way to point at a specific call moment.
- **Reactive monitoring, not proactive oversight.** The compliance
  team finds out about a problem after it's escalated, not during the
  pattern that produced it.

## Buying triggers (product-level, baseline)

What typically moves a buyer from "interested" to "actively
evaluating":

- **Regulatory pressure event** — new framework, recent enforcement
  action in their sector, audit failure.
- **Public complaint or PR incident** traceable to a phone interaction.
- **QA Manager departure or expansion** — the existing manual process
  no longer scales.
- **Contact centre headcount growth** crossing the threshold where
  manual sampling becomes statistically meaningless.
- **C360 adoption** — Insights360 is bundled with C360 Plus and
  Premium, so C360 expansion drives Insights360 conversion.
- **Renewal cycle on an enterprise QA tool** — buyer reviewing whether
  the £40–£160/seat outlay is still justified.

## Verbatim ICP language

**TBD — populated by the research team's `audience-intel` per campaign.** This
file holds the product-level baseline; per-sector verbatim language
(LinkedIn practitioner posts, trade press framings) lives in each
campaign's `icp-language-map.md`.

Baseline phrases the campaign team has observed from the product UI and existing
Conversant communications (use as starter, not authoritative):

- "Score 100% of calls."
- "Coaching prompts with evidence."
- "Rule failure patterns."
- "From reactive monitoring to proactive oversight."
- "We don't know what we're missing."

## Sector-specific archetypes

**TBD — populated by the research team per campaign.** Each campaign the research team pack
provides Module 1 (archetypes), specific to the target sector, with:

- Archetype name
- Sector-specific description
- Sourced pain points (confidence-tagged: strong/moderate/weak/speculative)
- Buying trigger specific to the sector
- Urgency level (burning-platform / educated / latent)

Examples of archetype shapes (from prior the research team work on UK legal):

- *Priced-out SMB legal practice* — pain is enterprise QA tool quotes
  with 50-seat minimums; trigger is SRA enforcement action in the
  sector.
- *Manual-QA floor manager* — pain is sampling becoming statistically
  meaningless above 30 seats; trigger is headcount growth.
- *CCaaS-locked buyer* — pain is QA module priced as part of a £105+/seat
  platform they can't unbundle; trigger is renewal cycle.

the campaign team reads the campaign the research team pack for archetype definitions, NOT
this file.

## Not our ICP (explicit exclusions)

- **Sub-5-seat operations.** £4.99/seat × <5 seats × £1,280 setup is
  not commercially viable for either side.
- **250+ seat enterprise contact centres.** Enterprise tools have
  features (WFM integration, advanced coaching workflows, agent
  desktop) Insights360 deliberately does not.
- **Real-time agent-assist use cases.** Insights360 is post-call only.
  If the buyer wants whisper coaching during the call, refer them
  elsewhere.
- **Pure call recording compliance** (e.g., MiFID II voice retention
  without analytics). Insights360 does not record — recordings come
  from the telephony platform. We analyse them.
- **Marketing attribution / call-tracking buyers** (Infinity,
  Mediahawk customers). Different category. Refer them elsewhere.
- **C-suite "digital transformation" narratives.** Buyer is
  operational, not strategic.

## Sources

- Product persona definitions: `(internal path)`
  (read 2026-05-18)
- Product overview: `(internal path)`
- Pricing: `(internal path)` and live
  site
- Compatible telephony list: live site, cross-referenced with
  `integrations.md`
- Prior sector archetype shapes: `(internal path)`
  and the research team's UK legal targeting pack
  (2026-05-15)

Per-campaign sources land in each campaign's research pack.
