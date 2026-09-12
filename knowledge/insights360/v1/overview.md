---
title: Insights360 — Overview
topic: insights360
author: product owner
last_verified: 2026-06-29
status: live
---

# Insights360

**See every conversation. Improve every outcome.**

Turn every customer conversation into actionable insight,
automatically — no matter which telephony platform you use.

## What it is

Conversant Technologies' multi-tenant SaaS contact-centre intelligence
platform. Post-call, fully automated quality assurance, agent
performance analytics, sentiment analysis, risk flagging, and
coaching prompts — built for contact centres running between 5 and 250
seats.

Available as a standalone product or as an integrated module of C360.

## The problem it solves

Manual QA in contact centres covers 2–5% of calls. The other 95% —
including every escalation, every compliance-adjacent conversation,
every churn signal — is invisible. Existing enterprise QA tools (NICE,
Verint/Calabrio, Qualtrics XM Discover) cost £40–£160 per seat per
month with 50–100 seat minimums and multi-year commitments. Inaccessible
to anyone under 50 seats.

Insights360 delivers the same coverage at £4.99–£9.99 per seat per
month with no seat minimum.

## How it works (post-call, four steps)

1. **Call ends** on your existing telephony platform.
2. **AI analyses** the recording — transcript, sentiment, QA score,
   risk flags, summary, suggested coaching — using AWS Bedrock Claude
   Haiku in the analysis pipeline.
3. **Scores and insights** are written to S3 and surfaced through the
   Insights360 dashboard typically within minutes of the call ending.
4. **Managers act faster** — Review Queue, Risks page, Agent detail
   page, and coaching prompts all point at evidence at the
   call-and-line level.

Insights360 does **not** run during the call. It is not a real-time
agent-assist tool. It is the post-call quality, compliance, and
coaching surface.

## Core features

All six are live in production:

- **Sentiment Analysis** — per-speaker sentiment scored across the
  call; surfaced in the Customer Sentiment chart and per-call detail.
- **Call Summaries** — short-form and long-form summaries pre-computed
  by the analysis pipeline.
- **Auto QA Scoring** — every call scored against tenant-configured
  rules. Scores roll up to KPIs (pass rate, average score,
  compliance rate).
- **Call Categorisation** — topic and reason classification configured
  per tenant via the Categories CRUD in Settings.
- **Risk Flagging** — compliance, customer-satisfaction, legal, and
  financial risk types configured per tenant. High-risk calls surface
  to the Risks page and the dashboard High-Risk Calls KPI.
- **Coaching Notes** — pre-computed coaching prompts surface in the
  call detail "Coaching & Actions" section. (Inline editing of coaching
  notes is in the v2 roadmap — Theme 3.)

## Compatible telephony platforms

Insights360 is architecturally telephony-agnostic. The analysis
pipeline accepts call recordings from:

- Microsoft Teams
- 3CX
- Cisco
- Avaya
- Mitel
- 8x8
- Five9
- RingCentral

Currently-wired connectors are a subset of the above — see
`roadmap.md` for which are live in production today vs which are
on-roadmap. New telephony connectors are scoped per-customer during
onboarding.

## Pricing

| Plan | Pooled hours/month | Price per seat/month |
|---|---|---|
| **Starter** | 40 hours | £4.99 |
| **Professional** | 70 hours | £7.99 |
| **Enterprise** | 100 hours | £9.99 |

- **No seat minimums** on any plan.
- **No annual lock-in.**
- **PAYG overage:** £0.50 per analysed hour beyond the pooled allowance.
- **Setup fee:** £1,280 (one-off, covers tenant provisioning and
  initial telephony wiring).
- **Config review:** £640 (one-off, scheduled around month 1, refines
  QA rules and risk types based on actual call patterns).

Insights360 is included in C360 Plus and C360 Premium packages, and
available as an add-on for C360 Lite or as a standalone product.

## Target users

- **Compliance teams** — looking for audit trail and 100% coverage of
  recorded interactions.
- **QA Managers and Analysts** — replacing manual sampling with
  automated scoring across the full call volume.
- **Operations Directors** — measuring agent performance, identifying
  systemic rule-failure patterns, justifying QA spend.
- **Contact Centre Managers** — dashboard-level volume and quality at
  a glance; anomaly callouts; period-over-period comparison.
- **Team Leaders** — coaching prompts with call-level evidence.

Agents themselves are NOT direct users in v1 — there is no agent
self-service portal. (Agent-facing UI is in the roadmap, Theme 5.)

## Where it runs

- **Hosting:** Vercel (fra1, Frankfurt).
- **Database:** Neon Postgres (AWS eu-central-1, Frankfurt — verified against the project's pulled Vercel env, 2026-07-16; previously misdocumented as "UK region").
- **Storage:** AWS S3 (eu-central-1, Frankfurt) for call data, scores, transcripts.
- **AI:** AWS Bedrock (Claude Haiku 4.5) + AWS Comprehend (sentiment), all
  within the analysis pipeline. The dashboard runs zero AI inference.
- **Auth:** Clerk (organisation-scoped multi-tenancy).

## Compliance and certifications

- **ISO 9001** (quality management) — Conversant group-level.
- **ISO 27001** (information security) — Conversant group-level.
- Data residency: UK / EU only. No cross-border data transfer outside
  the UK-EU adequacy framework.

## Relationship to C360

Insights360 is the analytics and quality layer that sits on top of
C360 (Conversant's unified Microsoft Teams communications platform).
The two products are sold together (Insights360 is bundled with C360
Plus and Premium) and independently (Insights360 standalone with any
of the compatible telephony platforms).

## Current stage

Live, GA, in production. Active v2 roadmap reorienting from "polished
read-only scoreboard" to "operating system for coaching" — see
`roadmap.md`.
