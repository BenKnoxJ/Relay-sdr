# CLAUDE.md

Guidance for Claude Code when working in this repository.

## Project Overview

Relay — an agentic AI sales and marketing platform for B2B sales reps. A rep gives an orchestrator a campaign in plain language; specialist agents research the market, find and buy contacts, write and post content, run tailored outreach over email and LinkedIn, and keep the CRM and admin current. The rep supervises and has the conversations. The rep is the user and the customer; the sales manager is the admin.

Blank-sheet successor to the parked Sales360 build. Service layers (Zoho CRM, Microsoft Graph mail, Lusha, humaniser gate, research-pack format, rep-words rule) carry over rewritten, never copied. Nothing on screen carries over.

**Product truth lives outside this repo:** master doc `~/vault/products/relay/relay-master-doc.md` (with `relay-roadmap.md` and `relay-module-reference.md`), compiled wiki `~/wiki/topics/relay/`. Read the master doc §1–2 before any product decision; its six principles are the decision rubric.

## Status

Phase 1 — build. The scaffold is in: Next.js App Router, tRPC + Zod, Prisma on Postgres (Neon in production, Docker locally), Clerk, and a plain Node worker running the Vercel AI SDK loop. There is no product code yet — no data model, no auth, no UI beyond a placeholder. Each Phase 1 task lands as one draft PR on `main`.

Runtime direction is settled (master doc §24): the AI SDK agent loop in a plain Node worker, durability in Postgres (`jobs` with claim, lease and reaper; `agent_runs`; `agent_run_steps`), approval as database state. **Not** the Claude Agent SDK, and **not** Vercel Workflow or Queues in Phase 1.

## Build discipline

- Every slice is built and tested locally on the VPS first: outputs, agent responses, the full loop.
- Every task opens a **draft PR** against `main` and goes through the review chain. Only Benny-san merges, and only he deploys.
- H1 slices in order: 1 campaign research + outreach; 2 content + posting; 3 CRM + admin; then one at a time. Nothing scales until H1 is nailed.
- Every agent run is a first-class record: inputs, steps, tool calls, outputs, cost.
- Rep words only in the UI, enforced in tests. No machine vocabulary on screen — every string lives in a copy file under `src/lib/copy/`.
- Design sign-off is Benny-san, screen by screen, against the written design standard.

## Repository Layout

```
src/app/                     Next.js App Router — screens and route handlers
  api/health/route.ts        GET /api/health → {"db":"ok"} (200) or {"db":"down"} (503)
  api/trpc/[trpc]/route.ts   tRPC over the fetch adapter
src/server/
  api/trpc.ts                tRPC context, router and procedure builders
  api/root.ts                the app router — every feature router is registered here
src/lib/                     framework-free code, shared by the app and the worker
  db.ts                      the only `new PrismaClient()` in the repository
  copy/                      every on-screen string
  repo/mutate.ts             the single write path — the transaction and the Event
src/worker/main.ts           the worker entry point — Postgres only, no Next, no Clerk
prisma/schema.prisma         the Phase 1 data model (master doc §25); slice-1 entities follow
prisma/migrations/           one migration per task, applied by `prisma migrate deploy`
tests/                       vitest `node` project (Postgres available)
tests/db/harness.ts          rebuild-and-migrate and empty-tables helpers for DB tests
tests/ui/                    vitest `ui` project (jsdom)
docker-compose.yml           local Postgres 16 on 127.0.0.1:5435
.github/workflows/ci.yml     typecheck, lint, build, test, worker smoke, gitleaks, audit
.audit-allowlist.json        runtime advisories CI carries, each with a reason and expiry
.gitleaks.toml               default rules, plus one allowlist for empty-valued env placeholders
```

**The app/worker boundary is load-bearing** (master doc §18). The app serves screens and tRPC; the worker runs jobs and agent runs; they speak only through Postgres. Nothing under `src/worker/**` or `src/lib/**` may import `next`, `@clerk/*`, `@/app/*` or `@/server/*`. That last one is what keeps the rule transitive: anything both sides need has to live in `src/lib`, which is itself checked. ESLint blocks the imports — static, dynamic `import()` and `require`, bare (`@/server`) and sub-path, at any relative depth and in any spelling (`./../app/x`, `../lib/../app/x`), in `.ts` and `.tsx` alike. A dynamic import in these layers must take a plain string literal, or the check cannot read it. `node:module` is banned there too, because `createRequire` reopens everything else. CI runs the worker under `env -i` so an ambient variable cannot hide a violation, and `tests/lint/boundary.test.ts` lints fixture files through the repo's own ESLint so each escape route stays closed.

**Nothing is deleted; states change** (master doc §25, rule 1). ESLint blocks Prisma `.delete()` and `.deleteMany()` calls everywhere except `src/lib/jobs/retention.ts`, which writes an Event. The rule matches the call *shape* (`<something>.<model>.delete(`), not a list of client names, so an aliased client (`const client = ctx.prisma; client.person.delete()`) is caught too. It also catches the computed spelling (`p.person["delete"]()`) and the delegate being handed to something else (`queueMicrotask(p.person.delete)`). `Map.delete` and friends are untouched: the receiver there is an identifier or a `new` expression, not a member access. Two things it does **not** catch, both by design: a destructured *delegate* (`const { person } = ctx.prisma; person.delete()`), and a model named `headers`, `searchParams`, `cookies` or `formData` — those four are exempt so that `req.headers.delete()` lints clean, so do not name a model one of them. Closing either gap needs typescript-eslint with type information, which is the upgrade path if a real delete ever slips through. See the comment block in `eslint.config.mjs` for the full reasoning. A Map or Set held on a field is a false positive and takes a one-line `eslint-disable`; `tests/lint/deleteBan.test.ts` pins both what fires and what stays quiet.

**Every write goes through `mutate` (master doc §25, rule 4).** A state change and its Event commit in one transaction, and `src/lib/repo/mutate.ts` is the only place that opens one: `mutate(db, { orgId, actor, kind, before, after, apply })` runs `apply(tx)`, inserts the Event on the same transaction, and returns what `apply` returned. Either both land or neither does, in both directions — an `apply` that throws rolls the Event back, and an Event that violates a constraint rolls the state change back. ESLint blocks Prisma `create`, `createMany`, `update`, `updateMany`, `upsert`, their `…AndReturn` forms and all four `$…Raw` calls — dotted and computed spellings both — everywhere in `src/**` except `src/lib/repo/**` and `src/lib/jobs/queue.ts`. `src/**` is the ban's whole reach, the same as the delete ban's: `prisma/seed.ts`, `scripts/**` and `tests/**` sit outside it on purpose, because seeding and test fixtures exist to put rows in directly and an Event per fixture row would be noise. The queue is a writer on purpose: enqueueing a job is not a domain event, and a `job.enqueued` Event per retry would bury the record it exists to be. The selector is the delete ban's shape and shares its limits — it catches an aliased client and the computed spelling, it does not see a destructured delegate. It costs more false positives than the delete ban does (`state.form.update(v)` matches), and the answer to one is a one-line `eslint-disable` with a reason. `tests/lint/writePath.test.ts` pins what fires and what stays quiet; `tests/repo/mutate.test.ts` pins the transaction in both directions.

**The data model is `orgId` on every row.** `prisma/schema.prisma` holds the Phase 1 half of master doc §25 — Org, User, ConnectedAccount, OAuthState, Event, Job, AgentRun, AgentRunStep, ProductFactsVersion, SideEffect — with cuid ids, snake_case `@map` names and `created_at`/`updated_at` on every table. Two exceptions, both deliberate: `orgs` has no `org_id` because it *is* the org, and `events` has no `updated_at` because an Event that can be edited is not a record of anything. No relation uses `onDelete: Cascade`; every one states `Restrict`, because nothing is deleted. `tests/db/migrate.test.ts` rebuilds the schema from empty and reads `information_schema` back, so these are checked properties of the migration rather than claims about the Prisma file.

## Commands

| What | Command |
|---|---|
| Install | `npm ci` |
| Local database up / down | `npm run db:up` / `npm run db:down` |
| Dev server (port 5200) | `npm run dev` |
| Everything CI checks, locally | `npm run check` (lint + typecheck + test) |
| Typecheck | `npm run typecheck` |
| Lint | `npm run lint` |
| Build | `npm run build` |
| Test | `npm run test` |
| Spike proofs only | `npm run proofs` |
| Dependency audit | `npm run audit` (needs the registry) |
| Worker, one pass | `npm run worker -- --once` |
| Worker bundle | `npm run worker:build` → `dist/worker/main.js` |
| Migrate (local) | `npm run db:migrate` |
| Migrate (deployed) | `npm run db:deploy` |

Environment: every variable, with placeholders, is listed in `docs/environment.md` — copy that block into a local `.env`. (A checked-in env template is not in the repo yet: Forge's guardrails refuse to write any `.env*` path, so it is Benny-san's to add.) Tests do not read `.env` — `tests/setup.ts` points them at `relay_test` and refuses to run against any database whose name does not end in `_test`.

**The `DEV_USER_EMAIL` sign-in bypass needs an explicit `development` or `test` environment; silence means production.** An unset or blank `NODE_ENV` resolves to `production` and the bypass is refused, because the one process that runs without a framework setting `NODE_ENV` for it is the worker, and a line missing from a unit file must not read as permission. `next build` is carved out on `NEXT_PHASE=phase-production-build` — a build serves no request. That carve-out is inferred from Next's documented behaviour, not yet confirmed against Vercel's serverless bundling: **Task 13 verifies it on a Vercel preview with a diagnostic log line** before real credentials sit behind the guard.

### AI SDK — verified export names (`ai@7.0.93`, `@ai-sdk/anthropic@4.0.49`, install of 2026-09-07)

Read off the installed package, not assumed. Re-check on upgrade.

- Multi-step / agent loop: `ToolLoopAgent`, `Experimental_Agent`; stop conditions via `stepCountIs`.
- Test doubles (from `ai/test`): `MockLanguageModelV4`, `MockLanguageModelV3`, `simulateReadableStream`, `convertArrayToReadableStream`.
- Both packages declare `zod: ^3.25.76 || ^4.1.8`; this repo is on zod 3.25.76.

## Workflow

Used by `/start-feature` and `/finish-feature`. Profile: `.claude/project.json`.

- **Owner:** personal (`BenKnoxJ`). **Not tracked in Jira.** Tickets are GitHub Issues on this repo.
- **product_label:** `relay`
- **Base branch:** `main` — feature branches off `main`, PRs merge back into it.
- **Branch naming:** `feature/<issue-n>-<kebab>`; `hotfix/<issue-n>-<kebab>` for urgent fixes.
- **PR title:** `[#<n>] <one-line summary>`.
- **Commit messages:** Conventional Commits (`feat:`, `fix:`, `chore:`).
- **Git identity:** `benknoxj@outlook.com` / Ben Knox-Johnston (set in local git config; never override with `-c` or env).
- **Active feature state:** `/start-feature` writes `.claude/active-feature.json` (gitignored); `/finish-feature` reads and removes it.
- **Human merge gate:** agents never merge — only Benny-san.

### Build / verify commands (used by `/finish-feature`)

| Step | Command | Run from |
|---|---|---|
| Install | `npm ci` | repo root |
| Lint | `npm run lint` | repo root |
| Build | `npm run build` | repo root |
| Test | `npm run test` | repo root |

## Dependency policy

Versions are pinned **exactly**, to the majors the rest of the fleet runs and the review chain knows: Next 15, React 19, tRPC 11, Prisma 6, Clerk 6, zod 3, Tailwind 3, vitest 3, ESLint 9, TypeScript 5. Registry-latest majors (Next 16, Prisma 7, Clerk 7, zod 4, Tailwind 4) are deliberately **not** taken — upgrades are their own tasks, after Phase 1. Patch and minor bumps inside a pinned major to close a security advisory are in scope for any task.

## VPS context — decision protocol

*Applies on the `clawdbot` VPS only.* Product decisions go in the master doc (LOCKED / DIRECTION LOCKED with a dated changelog line) and are mirrored to `~/wiki/topics/relay/articles/decisions.md`. Cross-cutting decisions: propose an entry for `~/vault/ops/decisions/RECENT.md` and wait for Benny-san's confirm.
