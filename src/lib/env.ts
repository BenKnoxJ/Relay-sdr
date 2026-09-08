import { z } from "zod";

/**
 * The one way code reads configuration.
 *
 * Nothing outside this file touches `process.env`: a variable that is missing,
 * empty or the wrong shape should stop the process at boot with the name of the
 * variable, not surface three screens later as an undefined passed to a driver.
 *
 * It lives in `src/lib` on purpose — the worker runs without Next or Clerk
 * (master doc §18), and the lint boundary proves this file imports neither.
 * The key list is `docs/environment.md`; the two stay in step.
 */

/**
 * `docs/environment.md` ships every optional key present and empty
 * (`TOKEN_ENC_KEY=""`), and dotenv loaders hand that through as `""` rather
 * than dropping it. An empty value means "not configured", so it is folded to
 * `undefined` before validation — otherwise every optional url and email would
 * fail on a freshly copied template.
 */
function optional<T extends z.ZodTypeAny>(inner: T) {
  return z.preprocess((value) => (value === "" ? undefined : value), inner.optional());
}

/**
 * The same fold for a value that has a default: a variable defined-but-blank
 * (a Vercel env var saved empty, `INTEGRATIONS=` in a file) means "not set",
 * and must take the default rather than fail the enum.
 */
function withDefault<T extends z.ZodTypeAny>(inner: T, fallback: z.infer<T>) {
  return z.preprocess((value) => (value === "" || value === undefined ? fallback : value), inner);
}

/**
 * A positive whole number of milliseconds with a default, for the worker's
 * timing knobs.
 *
 * `z.coerce.number()` is not enough on its own: it is `Number()`, which reads
 * `""` as 0, so a variable defined-but-blank would become a zero-millisecond
 * poll interval — a worker spinning a database round trip as fast as the event
 * loop allows. So empty folds to the default first, and the result must be an
 * integer above zero.
 *
 * The fold is `""` and nothing else, exactly as in `optional` and
 * `withDefault`: `"  "` is not a variable somebody left unset, it is one
 * somebody set wrong, and `Number("  ")` being 0 means `.positive()` refuses
 * it at boot with the variable's name. Loud is the right answer there.
 */
function positiveMs(fallback: number) {
  return z.preprocess(
    (value) => (value === "" || value === undefined ? fallback : value),
    z.coerce.number().int().positive(),
  );
}

/**
 * Base64 with no slack. `Buffer.from(s, "base64")` silently drops characters
 * outside the alphabet, so `Buffer.from("not a key!!!", "base64").length` is a
 * number like any other and a length check alone would accept junk.
 */
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/**
 * An http(s) origin. `z.string().url()` is not enough on its own: it is
 * `new URL()`, which reads `localhost:5200` as a URL with the scheme
 * `localhost:` and lets it through. Every url the app holds is fetched or
 * linked, so the scheme has to be one a browser will follow.
 */
const httpUrl = z
  .string()
  .url()
  .refine((s) => {
    const protocol = new URL(s).protocol;
    return protocol === "http:" || protocol === "https:";
  }, "must be an http:// or https:// URL");

/**
 * Decode a `TOKEN_ENC_KEY` to its 32 raw bytes, or throw saying why.
 *
 * It lives here rather than in `src/lib/services/crypto.ts` so the key is
 * checked once at boot with the same code that checks it at use, and so the
 * dependency runs one way: crypto reads env, never the other way round.
 */
export function decodeTokenKey(raw: string): Buffer {
  if (!BASE64.test(raw)) throw new Error("TOKEN_ENC_KEY is not valid base64");
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) {
    throw new Error(
      `TOKEN_ENC_KEY must decode to 32 bytes (base64 of 32 random bytes); this one is ${key.length}`,
    );
  }
  return key;
}

// Trimmed first, for the same reason connection strings are: the documented
// way to make one is `openssl rand -base64 32`, and a value pasted from a file
// or a terminal carries a trailing newline. Untrimmed, that fails as "not
// valid base64" and sends the operator looking at the key instead of the
// whitespace around it.
const encKey = z.preprocess(
  (value) => (typeof value === "string" ? value.trim() : value),
  z.string().superRefine((raw, ctx) => {
    try {
      decodeTokenKey(raw);
    } catch (error) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }),
);

/**
 * A Postgres connection string. `min(1)` was not enough: `"   "` passed it and
 * reached Prisma, which is precisely the failure this module exists to stop.
 * `prisma:` is allowed for Accelerate.
 */
function connectionString(name: string) {
  return z
    .string()
    .min(1, `${name} is required`)
    .refine((raw) => {
      try {
        const { protocol } = new URL(raw.trim());
        return protocol === "postgres:" || protocol === "postgresql:" || protocol === "prisma:";
      } catch {
        return false;
      }
    }, `${name} must be a postgres://, postgresql:// or prisma:// connection string`)
    // Return what was validated. Without this the refine parses a trimmed copy
    // and hands back the original, so `"  postgres://…  "` passes and the
    // whitespace still reaches whatever trusts `env().DATABASE_URL`.
    .transform((raw) => raw.trim());
}

const schema = z
  .object({
    /**
     * Set by `next build`, and read here so the guard below can tell a build
     * from a running server. It is in the schema rather than read off ambient
     * `process.env` so that `parseEnv(source)` is a function of its argument
     * alone: a caller validating a candidate environment gets the same answer
     * this process would.
     */
    NEXT_PHASE: optional(z.string()),

    // --- database ---------------------------------------------------------
    DATABASE_URL: connectionString("DATABASE_URL"),
    DIRECT_URL: connectionString("DIRECT_URL"),

    // --- app --------------------------------------------------------------
    /** Public origin of this deployment. OAuth redirects are built from it. */
    APP_URL: optional(httpUrl),
    /** `mock` runs every external integration against a local fake. */
    INTEGRATIONS: withDefault(z.enum(["mock", "live"]), "mock"),
    /** Encrypts stored provider tokens. See `src/lib/services/crypto.ts`. */
    TOKEN_ENC_KEY: optional(encKey),
    /** Local development only: sign every request in as this rep. */
    DEV_USER_EMAIL: optional(z.string().email()),
    /**
     * Unset or blank means production, not development.
     *
     * `INTEGRATIONS` folds an empty value to its safe end (`mock`); this one
     * has to do the same, and its safe end is `production`. The bypass guard
     * below is the reason: the app always has `NODE_ENV` set for it by Next,
     * but the worker is a bare Node process under systemd or Docker where a
     * missing variable is one forgotten line in a unit file. Defaulting to
     * `development` there would turn that omission into a live sign-in bypass,
     * silently. Defaulting to `production` turns it into, at worst, a terser
     * Prisma log.
     */
    NODE_ENV: withDefault(z.enum(["development", "test", "production"]), "production"),

    // --- worker -----------------------------------------------------------
    /**
     * How long the worker waits before polling again when the queue is empty.
     * Every value below is milliseconds, and every one of them is a knob for
     * the tests and for systemd rather than something an operator normally
     * sets: the defaults are the shipping values.
     */
    RELAY_WORKER_POLL_MS: positiveMs(2_000),
    /**
     * How long a claim holds a job before the reaper may take it back. It
     * defaults to the queue's own `LEASE_MS`; the proof-2 test shortens it so
     * that "wait for the lease to expire" is seconds rather than two minutes.
     */
    RELAY_WORKER_LEASE_MS: positiveMs(120_000),
    /**
     * How long a draining worker lets an in-flight handler run after SIGTERM.
     * Inside the unit's `TimeoutStopSec=600` on purpose (Task 13): the worker
     * has to give up before systemd does, or the SIGKILL that follows is the
     * one thing the drain existed to avoid.
     */
    RELAY_WORKER_DRAIN_MS: positiveMs(540_000),

    // --- auth (Clerk) -----------------------------------------------------
    CLERK_SECRET_KEY: optional(z.string()),
    NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: optional(z.string()),

    // --- model ------------------------------------------------------------
    ANTHROPIC_API_KEY: optional(z.string()),

    // --- Zoho CRM ---------------------------------------------------------
    RELAY_ZOHO_CLIENT_ID: optional(z.string()),
    RELAY_ZOHO_CLIENT_SECRET: optional(z.string()),
    RELAY_ZOHO_REFRESH_TOKEN: optional(z.string()),
    /** Where this org's Zoho lives, e.g. `https://crm.zoho.eu/crm/org12345`. */
    ZOHO_CRM_BASE_URL: optional(httpUrl),
    /**
     * `"1"` opts this process in to the live smoke probes, which write to — and
     * clean up after themselves in — the real CRM. Anything else, including
     * unset, is off, and it is refused outright when `NODE_ENV` is production.
     */
    RELAY_LIVE_TESTS: optional(z.string()),

    // --- Microsoft Graph --------------------------------------------------
    RELAY_MS_TENANT_ID: optional(z.string()),
    RELAY_MS_CLIENT_ID: optional(z.string()),
    RELAY_MS_CLIENT_SECRET: optional(z.string()),

    // --- research ---------------------------------------------------------
    TAVILY_API_KEY: optional(z.string()),
    FIRECRAWL_API_KEY: optional(z.string()),
  })
  .superRefine((value, ctx) => {
    // `DEV_USER_EMAIL` signs every request in as one rep with no credential.
    // Anywhere but a developer's own machine that is an unauthenticated door
    // into someone's pipeline, so it is not a warning: the process refuses to
    // start.
    //
    // The rule is an allowlist, deliberately. Asking "is this production?"
    // makes every environment the module cannot identify — unset, blank, a
    // value nobody anticipated — permissive, and the one host where NODE_ENV
    // is not set for us is the worker. So the bypass is accepted only where an
    // environment says, explicitly, that it is a development or test one.
    // Silence is production.
    //
    // The build is the one carve-out, and has to be. `next build` sets
    // NODE_ENV=production and loads the developer's local env file, so without
    // this every developer who filled in the documented bypass would find
    // `npm run build` dead on page-data collection. A build serves no request,
    // so the bypass cannot be used during one; a deployed server has
    // NEXT_PHASE unset or `phase-production-server` and is refused as before.
    const building = value.NEXT_PHASE === "phase-production-build";
    const bypassEnvironment = value.NODE_ENV === "development" || value.NODE_ENV === "test";
    if (!building && !bypassEnvironment && value.DEV_USER_EMAIL !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["DEV_USER_EMAIL"],
        message:
          "DEV_USER_EMAIL is a local-only bypass: it is accepted only when NODE_ENV is " +
          `explicitly "development" or "test", and this environment resolved to "${value.NODE_ENV}"`,
      });
    }

    // Live integrations store real provider tokens, and a token is only ever
    // written through the envelope in `src/lib/services/crypto.ts`. Without a
    // key that write fails at the moment a rep connects an account; failing
    // here instead says so before anyone tries.
    if (value.INTEGRATIONS === "live" && value.TOKEN_ENC_KEY === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["TOKEN_ENC_KEY"],
        message: "TOKEN_ENC_KEY is required when INTEGRATIONS=live: provider tokens are stored encrypted",
      });
    }
  });

export type Env = z.infer<typeof schema>;

/**
 * Validate an environment. Throws naming the offending variables.
 *
 * No secret is echoed: the only issues that report what they received are the
 * two enums, `INTEGRATIONS` and `NODE_ENV`, and neither holds a credential.
 * Every other message names the variable and says what was wrong with it.
 */
export function parseEnv(source: NodeJS.ProcessEnv | Record<string, string | undefined>): Env {
  const result = schema.safeParse(source);
  if (result.success) return result.data;

  const detail = result.error.issues
    .map((issue) => {
      const name = issue.path.join(".");
      return name ? `${name}: ${issue.message}` : issue.message;
    })
    .join("; ");
  throw new Error(`Invalid environment. ${detail}`);
}

let cached: Env | undefined;

/** The validated environment, parsed once per process. */
export function env(): Env {
  return (cached ??= parseEnv(process.env));
}

/** Test-only: drop the memoised environment so a later call re-reads `process.env`. */
export function resetEnv(): void {
  cached = undefined;
}

/**
 * The two variables the sign-in bypass turns on, and nothing else.
 *
 * A narrow schema rather than the full one because the caller that matters is
 * `src/middleware.ts`, which runs on the Edge runtime: validating
 * `DATABASE_URL` there would couple the request path that never touches the
 * database to the configuration of the one that does, and would do it on every
 * request. The two fields are declared identically to their entries in
 * `schema` above, so the fold of a blank value and the default of an absent
 * one are the same in both.
 */
const bypassSchema = z.object({
  NODE_ENV: withDefault(z.enum(["development", "test", "production"]), "production"),
  DEV_USER_EMAIL: optional(z.string().email()),
});

export type BypassEnv = z.infer<typeof bypassSchema>;

/**
 * The rep the local sign-in bypass signs in as, or `null`.
 *
 * The bypass is decided in one place, and this is it: the middleware skipping
 * Clerk and the tRPC context minting a session must never be able to disagree
 * about whether a request is signed in.
 *
 * It is deliberately stricter than the `parseEnv` guard above rather than a
 * restatement of it. `parseEnv` carves out `next build`, because a build loads
 * the developer's env file and serves no request; that carve-out is inferred
 * from Next's documented behaviour and is not yet confirmed against Vercel's
 * bundling (CLAUDE.md; Task 13 verifies it). So the value is accepted at boot
 * and refused here, at the one place it would actually sign somebody in. If
 * the inference turns out to be wrong, the cost is a build that cannot use the
 * bypass, not a production server that can.
 */
export function devBypassEmail(value: BypassEnv = readBypassEnv()): string | null {
  if (value.DEV_USER_EMAIL === undefined) return null;
  const bypassEnvironment = value.NODE_ENV === "development" || value.NODE_ENV === "test";
  return bypassEnvironment ? value.DEV_USER_EMAIL : null;
}

/**
 * Read the two by name, not by handing `process.env` over whole.
 *
 * Next inlines `process.env.SOMETHING` into an Edge bundle where it can see
 * the property being read; a dynamic read of the object cannot be inlined and
 * would arrive undefined in the middleware, turning "no bypass configured" and
 * "bypass configured" into the same answer. Two static reads keep that honest.
 *
 * Unmemoised, unlike `env()`: it is two property reads and a small parse, and
 * a memo here would make a test that changes the environment lie.
 */
export function readBypassEnv(): BypassEnv {
  const result = bypassSchema.safeParse({
    NODE_ENV: process.env.NODE_ENV,
    DEV_USER_EMAIL: process.env.DEV_USER_EMAIL,
  });
  // A malformed bypass address is not a reason to let a request through
  // unauthenticated, and it is not this function's job to stop the process —
  // `parseEnv` already refuses to boot on it. Here it simply means no bypass.
  //
  // The caller cannot then tell "unset" from "set but unusable", so the one
  // caller that reports it — `src/middleware.ts` — names all three
  // possibilities rather than asserting the one it cannot know.
  return result.success ? result.data : { NODE_ENV: "production", DEV_USER_EMAIL: undefined };
}

/**
 * The Clerk publishable key, or `null` when this deployment has no Clerk
 * account behind it.
 *
 * Read by name and not through `env()`, for two reasons. `NEXT_PUBLIC_`
 * variables are inlined by Next at the property read, so a dynamic lookup of
 * the whole object arrives undefined in a bundle; and the caller is
 * `src/app/layout.tsx`, which Next prerenders at build time — validating the
 * database connection string there would make `next build` depend on a
 * database it never touches.
 *
 * `null` rather than a throw, because running without Clerk is a first-class
 * case, not a misconfiguration: a developer on the `DEV_USER_EMAIL` bypass has
 * no key, and neither does CI.
 *
 * The inlining has a consequence worth knowing: this is answered by the build,
 * not by the environment the build runs in. An artifact built without the key
 * has no sign-in even if the key is present at run time. `docs/environment.md`
 * says so where an operator will read it.
 */
export function clerkPublishableKey(): string | null {
  const raw = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
  return raw === undefined || raw.trim() === "" ? null : raw.trim();
}
