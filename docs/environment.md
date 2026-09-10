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
# Relay's agents bill to the Claude subscription, not to an API key (decision,
# 2026-09-08, evidence 2026-09-09). This is the token `claude setup-token`
# prints, and it is the credential the worker reaches for first. It travels on
# the Claude Agent SDK (the Messages API refuses it): the worker starts the
# SDK's subprocess with this token, an isolated config dir (below), no built-in
# tools and only Relay's own tools. Worker only: the app makes no model calls in
# Phase 1, so it never belongs in a Vercel environment.
CLAUDE_CODE_OAUTH_TOKEN=""
# The fallback, used only when no subscription token is set, on the Messages
# API through @ai-sdk/anthropic. Never both at once: the worker sends exactly
# one credential, and the SDK subprocess is never handed the key.
ANTHROPIC_API_KEY=""
# Where the Agent SDK subprocess keeps its config (CLAUDE_CONFIG_DIR). Worker-
# owned and otherwise empty, so the subprocess reads nobody else's settings,
# hooks or MCP servers. Optional; default ~/.relay/agent-home, created on first
# use. The worker unit sets it explicitly.
RELAY_AGENT_HOME=""
# A scripted model, as JSON. LOCAL AND TEST ONLY — refused unless NODE_ENV is
# explicitly "development" or "test", with no carve-out for a build. It exists so
# the agent runtime can be proved through the real worker process with no
# credential; see src/lib/agents/stubModel.ts.
RELAY_AGENT_STUB_MODEL=""

# --- Zoho CRM -------------------------------------------------------------
RELAY_ZOHO_CLIENT_ID=""
RELAY_ZOHO_CLIENT_SECRET=""
RELAY_ZOHO_REFRESH_TOKEN=""
ZOHO_CRM_BASE_URL=""
RELAY_LIVE_TESTS=""

# --- Microsoft Graph ------------------------------------------------------
# The Entra app registration a rep's mailbox connect runs against. Under
# INTEGRATIONS=mock none of the three is read: Connect goes straight back to
# Relay's own callback with a fixed token set, so the whole flow is walkable
# with no app registration at all. Under INTEGRATIONS=live all three are, and
# the registration's redirect URI must be exactly
# "$APP_URL/api/oauth/graph/callback" - the app builds it from APP_URL and
# never from the request's own Host header, which is client-supplied.
RELAY_MS_TENANT_ID=""
RELAY_MS_CLIENT_ID=""
RELAY_MS_CLIENT_SECRET=""

# --- research -------------------------------------------------------------
# The research agent's two providers (research v2 §4): Tavily for search and
# the extract fallback, Firecrawl for page scrapes. Worker only. Under
# INTEGRATIONS=mock neither is read: the tools replay recordings from
# RELAY_TOOL_FIXTURES instead.
TAVILY_API_KEY=""
FIRECRAWL_API_KEY=""
# Where recorded provider responses live for mock mode (default
# fixtures/tools/research in the repository; the bench points it at one
# brief's subdirectory). RELAY_TOOL_RECORD="1" makes a live run write them.
RELAY_TOOL_FIXTURES=""
RELAY_TOOL_RECORD=""
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
  Accepted at boot is not the same as usable: `devBypassEmail()` in
  `src/lib/env.ts` is the one place that decides the bypass applies, and it
  refuses the build carve-out as well, so a build cannot sign anybody in even
  though it can start.
- **The model credential is the Claude subscription token, and only one
  credential is ever sent.** `CLAUDE_CODE_OAUTH_TOKEN` travels on the Claude
  Agent SDK: `src/lib/agents/provider.ts` starts the SDK's subprocess with the
  token in its environment, `CLAUDE_CONFIG_DIR` set to `RELAY_AGENT_HOME`, no
  filesystem settings, no built-in tools, and Relay's own tools as one
  in-process MCP server. The Messages API refuses this token (verified
  2026-09-09, three 429s), which is why it does not go through
  `@ai-sdk/anthropic`. With both variables set the token wins, the key is never
  read, and the subprocess is handed the token and explicitly not the key. The
  token is tied to a person's subscription, so it lives in the worker's own env
  file and the local shell, and nowhere near Vercel. **Verified live on
  2026-09-09**: `scripts/spike/cost-check.ts` ran a full echo run over the SDK
  and every recorded cost equalled the SDK's own figure per model and in total.
  `ANTHROPIC_API_KEY` alone selects the Messages API path, `x-api-key`, unchanged.
- **`RELAY_AGENT_STUB_MODEL` is refused outside development and test, with no
  build carve-out.** It scripts the model so the agent runtime can be proved
  through the real worker process without a credential. A stub model reaching
  production would be worse than a sign-in bypass: every agent in the org would
  answer from a fixture and every run would look healthy. `next build` makes no
  model call, so unlike `DEV_USER_EMAIL` there is nothing to carve out.
- **`DEV_USER_EMAIL` must be a work address, not a free mailbox provider.** The
  org a sign-in lands in is derived from the email domain, so `@gmail.com`,
  `@outlook.com` and the rest are refused for the bypass exactly as they are
  for a real sign-in — otherwise every holder of an address at one of them
  would be a member of the same org. `me@gmail.com` gives an app that looks
  signed in and refuses every action; use something like `you@yourcompany.com`
  (the domain need not exist).
- **A running server needs either the Clerk keys or the bypass — one or the
  other, never neither.** With `DEV_USER_EMAIL` set the middleware skips Clerk
  entirely, which is the local development case. With the keys set, sign-in is
  Clerk's. With neither, there is no way to establish who anybody is, so the
  middleware refuses every request with a 503 and one log line naming the
  missing variable rather than serving anything. Building and testing without
  either is fine and supported — that is how CI runs, with no Clerk account
  behind it — and it is only a *served request* that needs one of the two. Set
  both keys together: a publishable key with no secret key gives a sign-in
  screen that cannot complete.
- **`NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` must be set at BUILD time, not only at
  run time.** Next inlines every `NEXT_PUBLIC_` variable into the output at the
  point it is read, so whether the app mounts a `ClerkProvider` and renders a
  sign-in form is decided by the build, not by the environment the build is
  deployed into. An artifact built without the key and deployed with it has no
  working sign-in and says nothing about why. Set it on the project before the
  first deployed build, and rebuild after changing it.
- **`TOKEN_ENC_KEY` is required once `INTEGRATIONS=live`,** and must be 32
  random bytes base64-encoded (`openssl rand -base64 32`). It is the key for the
  stored provider tokens in `src/lib/services/crypto.ts`. Under `INTEGRATIONS=mock`
  it may be empty.
- **`RELAY_LIVE_TESTS="1"` opts this process in to the live smoke probes,**
  which create and then delete a real lead in the real Zoho org. It is the gate
  on `LiveZohoService.removeLeadForSmokeTest` — the only call Relay makes that
  destroys a record in a customer's CRM — and it is refused outright when
  `NODE_ENV` is `production`, switch or no switch. Leave it unset everywhere
  except a machine you are deliberately running the probe on.
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
