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
# "mock" runs every external integration against a local fake. Anything else
# hits the real provider.
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

- **Tests never read a local env file.** `tests/setup.ts` defaults
  `DATABASE_URL` to the `relay_test` database and refuses to start against any
  database whose name does not end in `_test`.
- **The worker reads `DATABASE_URL` and nothing else.** CI runs it under
  `env -i` to keep it that way (master doc §18).
- **Production** (Neon, Vercel) sets the same names; only the values differ.
