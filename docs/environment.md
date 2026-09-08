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
- **`DEV_USER_EMAIL` cannot be set in production.** It signs every request in as
  one rep with no credential, so `NODE_ENV=production` plus a value here is a
  refusal to start, not a warning. The one carve-out is `next build`, which sets
  `NODE_ENV=production` itself and reads this file: a build serves no request,
  so the bypass is unusable during one and the check is skipped there.
- **`TOKEN_ENC_KEY` is required once `INTEGRATIONS=live`,** and must be 32
  random bytes base64-encoded (`openssl rand -base64 32`). It is the key for the
  stored provider tokens in `src/lib/services/crypto.ts`. Under `INTEGRATIONS=mock`
  it may be empty.
- **`NODE_ENV`** is read as well (`development` | `test` | `production`,
  defaulting to `development`). The runtime sets it; it is not in the block
  above because it is not yours to write in a local `.env`.
- **Tests never read a local env file.** `tests/setup.ts` defaults
  `DATABASE_URL` to the `relay_test` database and refuses to start against any
  database whose name does not end in `_test`.
- **The worker reads `DATABASE_URL` and `DIRECT_URL` and nothing else.** It
  validates the same environment the app does, and those two are the only
  required keys, so the whole schema is satisfiable from them alone. CI runs the
  worker under `env -i` with exactly those two set to keep it that way (master
  doc §18).
- **Production** (Neon, Vercel) sets the same names; only the values differ.
