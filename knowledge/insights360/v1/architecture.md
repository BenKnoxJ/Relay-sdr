---
last_verified: 2026-06-29
---
# Insights360 — Architecture

## System A — AWS Pipeline

Everything outside the GitHub repo. All AWS resources in `eu-central-1` (Frankfurt), account `591338347562`. Never create resources in any other region — data residency requirement.

Pipeline topology:
Phone system (OAK / 3CX)
→ Ingestion Lambda (audio → S3)
→ Transcription worker: EC2 g4dn.xlarge GPU (NVIDIA T4), Lambda-orchestrated from a baked AMI — NOT AWS Batch (faster-whisper-family ASR + speaker diarization; exact model pinned in the worker AMI — pending infra confirmation, see audit 2026-06-29)
→ Analyser Lambda
→ Bedrock (Claude Haiku 4.5 — QA scoring, summaries, risks, coaching)
→ Comprehend (per-speaker sentiment)
→ S3 RESULTS_BUCKET (final JSONL)
→ Sync Lambda (S3 → Neon, every 60 min) [STATUS: VERIFY]

The Analyser Lambda is a dumb executor — zero hardcoded business logic. It reads `ai-config.json` and `qa-config.json` from S3 at runtime. Categories, risk types, and QA rule weights all come from those configs, managed via System B's settings UI. Any hardcoded rule names, weights, or categories in the Analyser are bugs.

System A is not in the GitHub repo. Code changes to the dashboard do not touch the pipeline. No further System A detail is maintained here — verify directly in AWS when needed.

## System B — Next.js Dashboard

Repo: `Conversant-Technologies-Ltd/insights360`. Vercel root directory: `frontend/`. Runs zero AI inference — confirmed: no Bedrock, Claude, Whisper, Comprehend, or any AI SDK in the codebase. The only AWS SDK package is `@aws-sdk/client-s3`.

### Frontend

Next.js ^15.5.12, App Router ONLY — never Pages Router (the opposite of C360). React 19. UI: Tailwind CSS ^3.4.18 (custom dark theme, brand teal `#2AD2C9`), Recharts ^3.6.0, Lucide React ^0.562.0, jsPDF ^4.2.0, @clerk/themes ^2.4.47. Components are hand-rolled — no shadcn, no Radix, no MUI.

NOT used (hard list): no tRPC, no Zod, no shadcn/ui, no React Query, no Redux. No test files or test framework anywhere — do not add one without explicit decision.

Route structure: `(auth)/` for login/sign-up/forgot-password, `(dashboard)/` for all protected routes (`/`, `/calls`, `/call/[callId]`, `/qa`, `/agents`, `/agent/[agentName]`, `/risks`, `/settings`), `api/` for backend.

### Backend

All backend is Next.js API Route Handlers (Vercel Serverless Functions). Auth: `getAuthContext()` in `frontend/src/lib/auth-utils.ts` — tries session cookie first, falls back to Bearer token (cci-lite JWT verified via `verifyToken()` with authorizedParties). Returns `{ tenantId, role, clerkOrgId }`.

Roles: `admin` (full access + settings writes), `supervisor` (read-only, no settings writes), `viewer` (read-only, no settings access). Enforced server-side on write endpoints. Data visibility is NOT role-gated — all roles see the same call data. `superAdmin: true` in user `publicMetadata` gates the Usage Dashboard (`/admin/usage`) — separate from org roles.

> **Target role model (0.4, locked 2026-07-02).** The canonical set is **6 roles** — Admin, Team Lead, QA Evaluator, Risk & Compliance Officer, Agent, Viewer. The current `supervisor` role is being **collapsed into Viewer + Team Lead** (it is ≡ Viewer today); existing supervisors migrate to Viewer. Canonical sources: `(internal path)` (step 0.4) and Master Product Document v4.0 §8.

20 API route handlers:
- `api/admin/backfill` — S3→Prisma sync, `INGEST_API_KEY` protected, excluded from Clerk middleware
- `api/agent-stats`, `api/agents` — agent performance data
- `api/calls`, `api/calls/[id]` — call list (Prisma) and single call detail (reads from S3)
- `api/health` — health check, excluded from Clerk middleware
- `api/me` — current user info
- `api/qa`, `api/qa/[id]` — QA data
- `api/risks` — risk items
- `api/settings`, `api/settings/ai-config`, `api/settings/qa-config`, `api/settings/organization` — config read/write to S3
- `api/stats` — KPI aggregation
- `api/team`, `api/team/[userId]`, `api/team/invite` — Clerk-based user management
- `api/topics` — topic data
- `api/webhooks/clerk` — Svix verified webhook receiver

### Identity fields

Four fields, three are the same string:

- `tenantId` = Clerk org slug (from `tenant_id` JWT claim) — canonical tenant key for S3 prefixes and Prisma queries. Appears in 23 files.
- `orgId` = alias of `tenantId` (same string) — backwards-compat, some routes destructure this instead. Purely stylistic divergence.
- `orgSlug` = alias of `tenantId` (same string) — only `api/me` reads it.
- `clerkOrgId` = real Clerk org ID (`org_xxx`) — structurally distinct. Used ONLY for Clerk SDK calls (team management, invites). Appears in 5 files.

Common mistake: passing `clerkOrgId` into an S3 path silently produces 404s. The reverse (slug to Clerk) fails with "organization not found."

Note: `middleware.ts` destructures `orgId` from Clerk's `auth()` — that's the Clerk SDK's name for the real `org_xxx` id, not the tenant slug. Naming collision worth knowing.

### Database

Prisma ^6.19.2 — PINNED, do not upgrade (v7 broke the build March 2026). Neon PostgreSQL via `DATABASE_URL` (pooled) and `DIRECT_URL` (migrations only).

Single model: `Call` → table `calls`. Unique constraint on `(tenantId, callId)`, indexes on `(tenantId, startTime|agentName|qaScore)`. PostgreSQL is the secondary indexed store — S3 is the primary store. Team/QA-config/settings live in S3, not Postgres. Transcripts, speaker mapping, summaryLong stay in S3, fetched on demand.

### Storage

Two S3 buckets via env vars (`frontend/src/lib/s3.ts`, `storage.ts`):

RESULTS_BUCKET: call records as JSONL under `{tenantId}/final/v1.0/{call_id}.json` — v2.0 schema. Contains call metadata, transcript, sentiment, QA evaluation (`qa_evaluation.overall_score`), AI insights (`summary_short`, `risks`, `topics`, `call_reason`), coaching notes. S3 helpers use paginated + parallel + dedup fetches with exponential-backoff retry.

CONFIG_BUCKET: per-tenant config keyed `{tenantId}/{resource}`:
- `ai-config.json` — categories + risk types (read by System A, editable via settings UI)
- `qa-config.json` — QA rules (weights must sum to 1.0, validated on PUT)
- `org-settings.json` — company name, timezone (display only)

No presigned URLs — all S3 access is server-side only.

### Data sync — two paths

When calls are missing, check both before concluding there's a bug:
- **Path 1 — `POST /api/admin/backfill`** (in-repo): `INGEST_API_KEY` protected, excluded from Clerk middleware. Walks S3 `tenantPrefix`, upserts into Neon via Prisma with `BATCH_SIZE = 50` chunks. Must be triggered externally — no Vercel cron. Supports `?force=true` and incremental watermark.
- **Path 2 — Sync Lambda** (System A): outside the repo. EventBridge every 60 min. Same upsert job. Status: VERIFY before assuming it's running.

Both are idempotent upserts — running both is safe.

### Environment variables

Source-referenced (`process.env.*`):
- `NEXT_PUBLIC_APP_URL` — JWT authorizedParties allowlist
- `CLERK_SECRET_KEY` — token verification
- `CLERK_WEBHOOK_SECRET` — Svix verification
- `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` — S3 client
- `RESULTS_BUCKET`, `CONFIG_BUCKET` — bucket names
- `INGEST_API_KEY` — guards backfill route
- `DATABASE_URL`, `DIRECT_URL` — Postgres (pooled + direct)
- `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` — Clerk SDK (implicit)

Note: root `.env.example` is stale (references Vite, wrong region `eu-west-2`, missing several vars). `frontend/.env.example` is more accurate but also incomplete.

### Infrastructure

Vercel, region `fra1` (Frankfurt), 60s function timeout (`vercel.json` pins both). Secrets are Vercel environment variables — System B does NOT use AWS Secrets Manager, Lambda, Batch, EventBridge, SQS, or any AWS service beyond S3.
