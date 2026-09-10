---
title: Insights360 — Roadmap
topic: insights360
author: product owner
last_verified: 2026-05-18
status: live
---

# Insights360 Roadmap

> **⚠ Canonical sources (2026-06-29).** This article is the **product positioning + shipped-vs-roadmap** reference for briefing (the campaign team/the content team/the sales team). The **current build sequence** (phases/steps, e.g. 0.3a / 0.7) is tracked in the **Implementation Spine** (`(internal path)`), driven by **Master Product Document v3.1**. The Theme/Sprint framing below predates the v3.1 pivot and is retained for positioning, **not** sequencing.

> **For the campaign team:** the campaign team must never brief the content team or the sales team on features
> listed in the **NOT YET LIVE** section. Pre-shipment content
> creates buyer expectations that the product cannot meet, which
> breaks the trust the brand voice is built to protect. If a the research team
> pack proposes an angle that depends on an unshipped feature, flag
> it under `angle-verdicts.md` as HOLD with reason
> `non-live feature`.

## SHIPPED features (production today)

These can be briefed freely:

| Feature | Status | Notes |
|---|---|---|
| Sentiment Analysis (per-speaker) | Live | Surfaced in Customer Sentiment chart, per-call detail, agent detail |
| Call Summaries (short and long) | Live | Pre-computed by System A, surfaced in call detail |
| Auto QA Scoring | Live | Tenant-configurable rules; scores roll up to KPIs |
| Pass Rate / Average QA Score / Compliance Rate KPIs | Live | Dashboard cards, full-dataset aggregation |
| Call Categorisation | Live | Tenant-configurable categories via Settings CRUD |
| Risk Flagging | Live | Compliance, customer-satisfaction, legal, financial risk types; tenant-configurable |
| High-Risk Calls Dashboard KPI | Live | Drill-through to Risks page |
| Calls Explorer (search + 10+ filters) | Live | Full-text and faceted search |
| Agent Performance pages (list + detail) | Live | Individual and team analytics |
| Coaching Notes (read-only) | Live | Pre-computed prompts in call detail "Coaching & Actions" section |
| Multi-tenant org isolation (Clerk-scoped) | Live | Admin/Supervisor/Viewer roles |
| Settings self-serve CRUD (Org, Categories, Risk Types, QA Rules editor) | Live | Most "Contact support" walls removed (SPRNT-156–160) |
| Audit-log stopgap (S3 JSONL per tenant) | Live | Every Settings PUT logged |
| Telephony connectors: 3CX, OAK | Live in production | Other compatible platforms scoped per-customer |

## Compatible-but-not-yet-wired telephony

Listed on the website as "Compatible" because the architecture
supports them, but **not currently wired into the analysis pipeline
for any production tenant**:

- Microsoft Teams
- Cisco
- Avaya
- Mitel
- 8x8
- Five9
- RingCentral

These can be scoped during onboarding for a new customer; lead time
varies by platform. the campaign team should NOT brief outbound or content that
implies any of these are turn-key live integrations today. Phrase as
"compatible with" or "scoped per customer" — never "out-of-the-box
integration with [X]" unless [X] is 3CX or OAK.

## NOT YET LIVE — features in the v2 roadmap

**the campaign team must never brief the content team on features in this section.** These
are real plans, but they are not currently in production. Briefing
them as if they were shipped creates buyer expectation gaps.

### Theme 2 — Self-Serve Product (Sprints 4–7)

- Inline QA Rule editor with real-time validation (current state: rules
  CRUD exists but lacks real-time test-against-call validation)
- Bulk category/risk-type import
- Per-tenant onboarding wizard

### Theme 3 — Workflow OS (Sprints 8–11)

- **Inline Coaching Notes editor** — Team Leaders editing/authoring
  coaching notes directly in the call detail page. Read-only display
  is live; inline editing is not.
- Review Queue — flagged calls routed to specific reviewers, status
  workflow (Open → In review → Resolved), SLA tracking.
- Anomaly callouts on dashboard — automatic surfacing of unusual
  patterns (e.g., this week's compliance rate is 3 SD below the
  trailing 4-week average).

### Theme 4 — Audio + Transcript Depth (Sprints 12–14)

- In-browser audio playback with synchronised transcript scroll.
- Word-level confidence indicators on transcripts.
- Speaker timeline visualisation.
- "Listen to evidence" links throughout (every QA score, every risk
  flag links to the audio moment).

> **the campaign team note — compliance use case:** "Listen to evidence" is the
> v2 proof-of-concept for the compliance use case. When the campaign team briefs
> compliance-led campaigns, flag Theme 4 as the unlock — auditors
> being able to listen to the specific call moment that produced a
> risk flag is the load-bearing claim. Do NOT brief it as shipped
> today (it isn't), but DO use it as the v2 narrative anchor when the
> archetype is compliance-led and the buying horizon is 2–3 quarters.

### Theme 5 — People / Members / Teams / Roles (Sprints 15–18)

- **Agent self-service portal** — agents log in to see their own wins,
  development areas, anonymised peer cohort. Currently agents are NOT
  users.
- Teams as first-class entities (current state: agents grouped by
  arbitrary filters).
- SCIM provisioning.

### Theme 6 — Enterprise Readiness (Sprints 19–22)

- Full audit log (current state: stopgap S3 JSONL exists)
- Compliance evidence packs (auto-generated for FCA, GDPR, etc.)
- SSO (SAML, OIDC beyond Clerk's defaults)
- MFA enforcement policies
- Customer-managed encryption keys (BYOK)

## v2 reorientation (north star)

Insights360 today is a polished read-only scoreboard. **Insights360
v2 is an operating system for coaching.** The six themes above all
serve that reorientation. When briefing strategic content about the
product's direction, "operating system for coaching" is the canonical
v2 framing.

## Recent shipped highlights (Sprint 1 — 2026-05-13)

For context on what's just landed and is brief-worthy:

- Credibility & Design System: 8 calculation bugs fixed in PR #13
  (high-risk bar multiplier, pass rate weighting, sample-size
  blindness, grade hardcoding, sentiment normalisation, compliance
  rule hardcoding, rule weight, threshold drift across 4 surfaces).
- Settings self-serve MVP: 4 "Contact support" walls removed (Org name
  / timezone CRUD, Categories CRUD, Risk Types CRUD, Supervisor role
  in dropdown).
- Audit-log stopgap: per-tenant S3 JSONL append on every Settings PUT.

## Critical path / blockers

- **Sprint 8 entry** requires confirmed SLA from the System A Lambda
  owner (the analysis pipeline owner). Without this, the Workflow OS
  Theme 3 cannot reliably deliver Review Queue routing.

## Change log

| Date | Change |
|---|---|
| 2026-05-13 | Sprint 1 (Credibility & Design System) closed. v2 themes ratified. |
| 2026-05-18 | Roadmap restructured for the campaign team consumption — explicit SHIPPED / NOT YET LIVE sections; telephony connector reality vs website compatibility separated; the campaign team-guard note added at the top; Theme 4 compliance-narrative note added. |
| 2026-06-09 | Wave 1 (Credibility v2 & Design System) opened. First slice raised as draft PR #66 (SPRNT-217): shared design-system primitives (`<Card>`/`<KpiCard>`/`<Dropdown>`), typography tokens, WCAG-AA grade-pill contrast, a brand-hex ESLint guard, and nav accessibility attrs. Internal/infra — **not yet merged, not briefable.** |
