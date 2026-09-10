---
last_verified: 2026-06-29
---
# Insights360 — Integrations

Insights360's integration surface is narrow by design. System B (the dashboard) only talks to Clerk, S3, and Neon. All phone system and AI integrations are System A's domain.

## Clerk

Identity and auth. Every tenant = one Clerk org. Auth via `clerkMiddleware` — session claims provide `tenant_id`, `org_id`, `app_role`. JWT template `cci-lite` must include custom claims. `getAuthContext()` resolves tenantId (slug), role, and clerkOrgId. Separate Clerk instance from C360 — users/orgs not shared.

**2026-05-18 — Admin impersonation works end-to-end.** Custom `LoginClient` consumes the `__clerk_ticket` query param via `signIn.create({ strategy: 'ticket' })`, and middleware forwards any authenticated session with no active org to a new `/select-org` route that calls `setActive()` on the user's first org membership. Allowed-origins list in the Clerk Dashboard must include both `insights360.technology` and `www.insights360.technology` — the latter was the silent failure mode (403 on `/v1/client` and `/v1/environment`, login page stuck on its loading spinner). Known follow-ups: impersonated writes are not yet audit-trailed (the JWT `act` actor claim is available but unread by `getAuthContext`); multi-org users get an arbitrary first-membership rather than a picker. (SPRNT-189, PRs #36, #38)

## AWS S3

The only AWS service System B uses. Two buckets:
- **RESULTS_BUCKET** — call record JSONL produced by System A. System B reads only.
- **CONFIG_BUCKET** — per-tenant config (`ai-config.json`, `qa-config.json`, `org-settings.json`). System B reads and writes via the settings UI.

All access server-side via `@aws-sdk/client-s3`. No presigned URLs.

## Neon PostgreSQL

Secondary indexed store for call data. Single `calls` table. Populated via backfill route (Path 1) or Sync Lambda (Path 2). Prisma ^6.19.2 pinned.

## Phone systems (System A only)

OAK / ClarifyGo and 3CX feed audio into System A's ingestion Lambdas. System B has no direct relationship with these providers — it only consumes the processed output from S3. Phone system credentials live in AWS Secrets Manager at `cci-lite/{provider}/{tenantId}`, managed via C360's onboarding flow (see [[c360-overview|C360 overview]]).

## AI services (System A only)

Bedrock (Claude Haiku 4.5), Comprehend (sentiment). System B has zero AI SDKs or inference. All AI-generated content arrives pre-computed in S3 JSONL.

## Telephony: compatible-vs-wired (canonical — what marketing may claim)

Reconciled 2026-06-03 after the marketing (brand-voice.md) and engineering lists diverged.

- **Compatible with** the major telephony platforms — Microsoft Teams, 3CX, Cisco, Avaya, Mitel, 8x8, Five9, RingCentral, OAK (ClarifyGo) — because System A ingests the recordings those platforms produce. Marketing may name them (see brand-voice.md).
- **Automated feed wired:** **3CX and OAK (ClarifyGo)** only. Every other platform is "scoped per customer during onboarding."

**Voice rule for the content team (not gate-enforced — a phrasing nuance):** claim *compatibility* freely ("works with recordings from / compatible with X"); do NOT imply a *seamless / automated / connected integration* for platforms beyond 3CX + OAK. The "seamlessly" exception for Microsoft Teams in brand-voice.md predates this reconciliation — treat Teams as compatible, not as an automated feed, until engineering confirms otherwise.
