# Environment

Every variable the repo reads, with a placeholder value. Copy the block below
into a local `.env` (gitignored) and fill it in.

> **Why this is a doc and not a checked-in env template:** Forge's guardrails
> refuse to write any path matching `.env*`, secrets or not. The template file
> is Benny-san's to add — the block below is its exact intended content. Until
> it exists, this file is the reference. See the Task 1 handoff.

```dotenv
# --- database -------------------------------------------------------------
# Local: npm run db:up (see docker-compose.yml).
DATABASE_URL="postgresql://relay:relay@127.0.0.1:5435/relay"
DIRECT_URL="postgresql://relay:relay@127.0.0.1:5435/relay"

# --- app ------------------------------------------------------------------
APP_URL="http://localhost:5200"
# "mock" runs every external integration against a local fake; "live" hits the
# real provider. Those two values and no others: anything else refuses to boot.
INTEGRATIONS="mock"
# 32 random bytes, base64. Encrypts stored provider tokens.
TOKEN_ENC_KEY=""
# The rep signed in as during local development.
DEV_USER_EMAIL=""

# --- worker ---------------------------------------------------------------
# Milliseconds. Leave these blank unless you are tuning or testing: the
# defaults below are the shipping values, and a blank takes the default.
# Wait between polls when the queue is empty (default 2000).
RELAY_WORKER_POLL_MS=""
# How long a claim holds a job before the reaper may take it back (default
# 120000). The proof-2 test shortens it so "wait for the lease to expire" is
# seconds; the worker renews every quarter of it while a handler runs.
RELAY_WORKER_LEASE_MS=""
# How long a draining worker lets an in-flight handler finish after SIGTERM
# (default 540000). Must stay inside the unit's TimeoutStopSec.
RELAY_WORKER_DRAIN_MS=""

# --- auth (Clerk) ---------------------------------------------------------
CLERK_SECRET_KEY=""
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=""

# --- model ----------------------------------------------------------------
ANTHROPIC_API_KEY=""

# --- Zoho CRM -------------------------------------------------------------
RELAY_ZOHO_CLIENT_ID=""
RELAY_ZOHO_CLIENT_SECRET=""
RELAY_ZOHO_REFRESH_TOKEN=""
ZOHO_CRM_BASE_URL=""

# --- Microsoft Graph ------------------------------------------------------
RELAY_MS_TENANT_ID=""
RELAY_MS_CLIENT_ID=""
RELAY_MS_CLIENT_SECRET=""

# --- research -------------------------------------------------------------
TAVILY_API_KEY=""
FIRECRAWL_API_KEY=""
```

## Notes

- **`src/lib/env.ts` is the only thing that reads `process.env`.** It validates
  the whole list above at boot with zod and throws naming the offending
  variable, so a missing or misshapen value stops the process rather than
  surfacing as an `undefined` three screens later. Call `env()`; never
  `process.env`. An empty value (`TOKEN_ENC_KEY=""`, as this template ships it)
  counts as unset.
- **`DEV_USER_EMAIL` is accepted only in an explicitly development or test
  environment.** It signs every request in as one rep with no credential, so
  anything else — `NODE_ENV=production`, or `NODE_ENV` unset or blank — plus a
  value here is a refusal to start, not a warning. Silence means production:
  the app always has `NODE_ENV` set for it by Next, but the worker is a bare
  Node process, and a variable missing from a unit file must not read as
  permission. If you run `npm run worker` locally with this filled in, export
  `NODE_ENV=development` in the shell you run it from: the worker is a bare
  `tsx` process and reads the process environment, never a `.env` file (the app
  gets that from Next, and CI passes the two database keys explicitly). The one carve-out is `next build`, which
  sets `NODE_ENV=production` itself and reads this file: a build serves no
  request, so the bypass is unusable during one and the check is skipped there.
- **`TOKEN_ENC_KEY` is required once `INTEGRATIONS=live`,** and must be 32
  random bytes base64-encoded (`openssl rand -base64 32`). It is the key for the
  stored provider tokens in `src/lib/services/crypto.ts`. Under `INTEGRATIONS=mock`
  it may be empty.
- **`NODE_ENV`** is read as well (`development` | `test` | `production`),
  and an unset or blank value defaults to `production` — the safe end of the
  field, since the bypass rule above turns on it. The runtime normally sets it,
  which is why it is not in the block above; add it to a local `.env` only if
  you run the worker directly.
- **Tests never read a local env file.** `tests/setup.ts` defaults
  `DATABASE_URL` to the `relay_test` database and refuses to start against any
  database whose name does not end in `_test`.
- **`DATABASE_URL` is trimmed and handed to the Prisma client directly**
  (`datasourceUrl` in `src/lib/db.ts`), so the value the application dials is
  the one this module validated. `DIRECT_URL` stays a `schema.prisma` read: it
  belongs to the migration CLI, which runs without the app.
- **The worker reads `DATABASE_URL` and `DIRECT_URL` and nothing else.** It
  validates the same environment the app does, and those two are the only
  required keys, so the whole schema is satisfiable from them alone. CI runs the
  worker under `env -i` with exactly those two set to keep it that way (master
  doc §18).
- **Production** (Neon, Vercel) sets the same names; only the values differ.
- **The worker's three knobs are milliseconds and have defaults.**
  `RELAY_WORKER_POLL_MS` (2000), `RELAY_WORKER_LEASE_MS` (120000) and
  `RELAY_WORKER_DRAIN_MS` (540000) each fall back to the shipping value when
  unset or blank, so the worker needs nothing beyond the two connection
  strings — which is all the CI boundary smoke gives it (`DATABASE_URL` and
  `DIRECT_URL`; rubric proof 5's harness adds `INTEGRATIONS=mock`, which is
  already the default). A value that is not a
  whole number above zero refuses to boot rather than silently becoming a
  zero-millisecond poll. `RELAY_WORKER_DRAIN_MS` must stay inside the systemd
  unit's `TimeoutStopSec`: the worker has to give up before systemd does, or
  the SIGKILL that follows is the thing the drain existed to avoid.
