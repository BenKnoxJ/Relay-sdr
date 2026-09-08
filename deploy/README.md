# Deploying Relay

Relay runs in two places, and the split is the one in master doc §18.

| Piece | Home | Why |
| --- | --- | --- |
| App (Next.js) | Vercel, **preview deployments only** | Serves screens and tRPC. Production promotion is a deliberate human step, not a merge. |
| Worker | This VPS, a systemd **user** unit | A long-lived process that claims jobs and runs agent steps. Vercel has nowhere to put one, and §24 rules out Workflow and Queues for Phase 1. |
| Database | Neon | Both halves talk only through it. |

A container for the worker was considered and rejected: every other long-lived service on this machine is a user unit, and being the one exception costs more than it buys.

## Environment

The worker reads its environment from `~/.secrets/relay-worker.env`, mode `600`, owned by the operator. It is never in this repository, and no agent writes it.

The names, and nothing else — values are Benny-san's:

| Name | Notes |
| --- | --- |
| `DATABASE_URL` | Neon **pooled** connection string. |
| `DIRECT_URL` | Neon **direct** connection string. Migrations run over this one. |
| `NODE_ENV` | `production`. Also what makes `db:deploy` refuse a local database. |
| `INTEGRATIONS` | `live` or `mock`. |
| `TOKEN_ENC_KEY` | Required when `INTEGRATIONS=live`; provider tokens are stored encrypted. |
| `ANTHROPIC_API_KEY` | Agent steps. |
| `TAVILY_API_KEY`, `FIRECRAWL_API_KEY` | Research tools. |
| `RELAY_MS_TENANT_ID`, `RELAY_MS_CLIENT_ID`, `RELAY_MS_CLIENT_SECRET` | Microsoft Graph. |
| `RELAY_ZOHO_CLIENT_ID`, `RELAY_ZOHO_CLIENT_SECRET`, `RELAY_ZOHO_REFRESH_TOKEN`, `ZOHO_CRM_BASE_URL` | Zoho CRM. |

Optional, with defaults in `src/lib/env.ts`: `RELAY_WORKER_POLL_MS` (2000), `RELAY_WORKER_LEASE_MS` (120000), `RELAY_WORKER_DRAIN_MS` (540000).

A misconfigured worker does not start. It exits 1 having written one JSON object to stderr with `"event":"failed"` and the offending names — so `systemctl --user status relay-worker` and the journal say what is wrong, rather than a stack trace.

## Install

From `~/projects/relay`, on the commit you intend to run:

```sh
git pull
npm ci                       # NODE_ENV must NOT be production here — the build needs devDependencies
npx prisma generate          # the client is external to the bundle; it must exist on disk
npm run worker:build         # → the whole dist/ tree (see below)

# Migrations, against Neon, over DIRECT_URL. The subshell is the point: the
# connection strings live in the worker's environment file, which systemd reads
# and a shell does not, and sourcing it also sets NODE_ENV=production — correct
# for this step, and the reason it comes after `npm ci` rather than before it.
( set -a; . ~/.secrets/relay-worker.env; set +a; npm run db:deploy )

install -D -m 644 deploy/relay-worker.service ~/.config/systemd/user/relay-worker.service
systemctl --user daemon-reload
systemctl --user enable --now relay-worker.service
```

Two things in that order are load-bearing, both learned the hard way:

- **`npm ci` before anything sets `NODE_ENV=production`.** npm omits devDependencies under that setting, and `tsup` and the Prisma CLI are both devDependencies — `worker:build` would fail on a missing binary.
- **The environment file is sourced only for the migration step,** in a subshell, so `NODE_ENV=production` does not leak back into the install shell. It is the operator's own file and sourcing executes it; that is the fleet idiom, and it is why nothing else in this repo writes to it.

Then watch it claim something:

```sh
journalctl --user -u relay-worker -f
```

A healthy start is one line: `{"event":"started","mode":"loop","db":"ok", …}`.

`worker:build` emits more than the entry point. tsup code-splits, so `dist/` also holds the sibling chunks `main.js` imports at runtime — including the one carrying the dynamic `@/lib/db` import, which is deliberately a separate chunk. Deploy the **whole `dist/` tree**; copying `dist/worker/main.js` on its own gives `ERR_MODULE_NOT_FOUND` at the first claim rather than at startup.

### Upgrading

Same steps without the `install`/`enable` pair, then `systemctl --user restart relay-worker`. The restart is a drain (below), so it is safe with jobs in flight.

`npx prisma generate` is not optional on an upgrade. `@prisma/client` is deliberately **external** to the tsup bundle — the generated client loads a native query engine by path, and bundling it breaks that lookup — so the bundle imports a client that has to be present and current in `node_modules`.

## Restart and drain

`KillSignal=SIGTERM`, and the worker handles it:

1. It stops claiming immediately.
2. The job in flight gets `RELAY_WORKER_DRAIN_MS` (540s) to finish.
3. If it runs out, the worker **releases** the job: back on the queue, due now, and the attempt it spent is refunded. A deploy does not charge every in-flight job an attempt, and does not terminally fail one that happened to be on its last.
4. `TimeoutStopSec=600` is systemd's own deadline and is deliberately *larger*. Reaching it means a SIGKILL, which leaves the job leased until the reaper takes it — correct, but strictly worse than step 3. `tests/deploy/unit.test.ts` asserts the two stay in that order **as the unit file ships them**.

That last assertion has a hole worth knowing about: `EnvironmentFile=` overrides `Environment=`, so setting `RELAY_WORKER_DRAIN_MS` above 600000 in `~/.secrets/relay-worker.env` buys a SIGKILL instead of a clean release, and nothing at runtime objects. If you raise the drain, raise `TimeoutStopSec` with it.

`StartLimitIntervalSec=300` / `StartLimitBurst=5` are what make `OnFailure=` mean anything. Without them, `Restart=on-failure` with `RestartSec=15` never reaches the default start limit, so a permanently broken worker restarts every fifteen seconds indefinitely, never enters `failed`, and never alerts.

A second SIGTERM before the drain finishes means "not in nine minutes": the handler is aborted and the job given back by the same path.

The unit execs `dist/worker/main.js` under plain `node`, never `npm` and never `tsx`. The `tsx` CLI runs its script in a *child* process, so systemd's SIGTERM would land on the wrapper and the worker would be killed at the stop timeout with a job still leased (found in Task 5, PR #6). `Restart=on-failure` with `RestartSec=15`; the worker exits non-zero only after `MAX_CONSECUTIVE_FAILURES` (10) failed polls in a row, so a database that blinks does not become a restart loop.

## Migrations

`npm run db:deploy` runs `scripts/db-deploy.sh`, which is `prisma migrate deploy` plus one refusal: it will not run against a local database unless the environment says explicitly that it is a development or test one.

The accident it exists to stop is quiet. A shell that has been doing local work still exports the Docker connection string; the production migration step is run in it; Prisma finds the migrations already applied to `relay`, prints "No pending migrations", exits 0 — and Neon is untouched while the deploy reports green.

The rule is an allowlist — **silence is production** — the same rule `src/lib/env.ts` applies to `DEV_USER_EMAIL`, and for the same reason: `NODE_ENV` is unset in an ordinary shell, so a guard keyed on it *being* `production` would have fired nowhere at all. The cost is that a deliberate local run needs `NODE_ENV=development` exported, exactly as `docs/environment.md` already requires for `npm run worker`. On the VPS the sourced environment file supplies `NODE_ENV=production`, and Neon is not a local host, so the deploy step is unaffected.

Both URLs are checked because the migration engine connects over `DIRECT_URL` — a Neon `DATABASE_URL` with a leftover local `DIRECT_URL` is the same accident, wearing the half that matters. Connection strings missing from the environment are read from a local `.env`, which is what Prisma would have done; the process environment wins where both have a value.

`NODE_ENV` is the one variable **not** read from `.env`. It is what decides whether the guard applies, and `docs/environment.md` tells developers to put `NODE_ENV=development` in that file for the app's benefit — so reading it here would let a checked-out file switch the guard off. It must be exported.

Hosts are classified by parsing the URL with Node rather than by cutting the string up: userinfo containing a `/`, a bracketed IPv6 literal, and a `?host=/var/run/postgresql` unix socket each defeat a different naive split, and all three defeat it in the same direction — a local database read as remote. A connection string that cannot be parsed is refused rather than assumed remote. `--dry-run` runs every check and stops before Prisma; any other flag is passed through. The Prisma CLI is invoked as `node_modules/.bin/prisma`, never `npx prisma`, so a missing devDependency is an error instead of an unpinned download aimed at Neon.

## Vercel

The app deploys to **preview only**. `vercel.json` is not yet in the repository — see the PR; it needs a guard lift. When it lands it should be:

```json
{
  "$schema": "https://openapi.vercel.sh/vercel.json",
  "framework": "nextjs",
  "git": { "deploymentEnabled": { "main": false } }
}
```

`deploymentEnabled.main: false` is what makes "preview only" true rather than aspirational: merging to `main` builds nothing, and production is reached by a deliberate `vercel deploy --prod`. Delete that key when Phase 1 exits and production becomes a real destination.

`postinstall` runs `prisma generate`, so a Vercel build gets its client without extra configuration. The build needs `DATABASE_URL` and `DIRECT_URL` set in the Vercel project — page-data collection evaluates `src/lib/env.ts`, and it refuses to parse without them.

### The `NEXT_PHASE` carve-out (Sentinel, PR #2)

`src/lib/env.ts` allows `DEV_USER_EMAIL` during a build, recognising the build by `NEXT_PHASE === "phase-production-build"`. Sentinel flagged that nobody had confirmed Next actually sets that variable. It does, and this is the receipt (Next 15.5.25, clean `.next`, probe inside the `superRefine`):

```
{"NEXT_PHASE":"phase-production-build","NODE_ENV":"production",
 "seenNodeEnv":"production","seenPhase":"phase-production-build"}
```

One trap worth writing down, because it cost an hour: **`next.config.mjs` is the wrong place to measure this.** The config is loaded before Next sets `NEXT_PHASE`, so a diagnostic there reports `null` and looks like proof the carve-out is dead. Only the worker processes that evaluate server modules — the ones that run `env()` — see it.

To re-confirm on Vercel once the project is linked: run a preview deployment with `DEV_USER_EMAIL` set in the preview environment. A green build means the carve-out held; a build that dies on `Invalid environment. DEV_USER_EMAIL: …` means it did not, and `env.ts` needs a different signal. Unset the variable afterwards.

## Registry

`~/vault/ops/projects.json` should carry `"service": "relay-worker"` for the `relay` entry, and the wiki's `environments.md` should list the three environments (local Docker, VPS worker against Neon, Vercel preview). Both live outside this repository; see the PR.
