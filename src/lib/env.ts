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

const encKey = z.string().superRefine((raw, ctx) => {
  try {
    decodeTokenKey(raw);
  } catch (error) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: error instanceof Error ? error.message : String(error),
    });
  }
});

const schema = z
  .object({
    // --- database ---------------------------------------------------------
    DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
    DIRECT_URL: z.string().min(1, "DIRECT_URL is required"),

    // --- app --------------------------------------------------------------
    /** Public origin of this deployment. OAuth redirects are built from it. */
    APP_URL: optional(httpUrl),
    /** `mock` runs every external integration against a local fake. */
    INTEGRATIONS: z.enum(["mock", "live"]).default("mock"),
    /** Encrypts stored provider tokens. See `src/lib/services/crypto.ts`. */
    TOKEN_ENC_KEY: optional(encKey),
    /** Local development only: sign every request in as this rep. */
    DEV_USER_EMAIL: optional(z.string().email()),
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),

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
    // In production that is an unauthenticated door into someone's pipeline,
    // so it is not a warning: the process refuses to start.
    if (value.NODE_ENV === "production" && value.DEV_USER_EMAIL !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["DEV_USER_EMAIL"],
        message: "DEV_USER_EMAIL is a local-only bypass and must not be set in production",
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
 * Validate an environment. Throws with the offending variable names and
 * nothing else — a value is never echoed, because most of them are secrets.
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
