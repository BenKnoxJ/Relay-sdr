import { randomBytes } from "node:crypto";

import { describe, it, expect, afterEach } from "vitest";

import { parseEnv, env, resetEnv } from "@/lib/env";

/** A valid 32-byte base64 key, generated rather than checked in. */
const KEY = randomBytes(32).toString("base64");

/** The smallest environment the repo can start under. */
function base(): Record<string, string | undefined> {
  return {
    DATABASE_URL: "postgresql://relay:relay@127.0.0.1:5435/relay",
    DIRECT_URL: "postgresql://relay:relay@127.0.0.1:5435/relay",
  };
}

describe("parseEnv", () => {
  it("accepts the documented example values", () => {
    const parsed = parseEnv({
      ...base(),
      // `docs/environment.md` is a local `.env`, and a local shell running the
      // worker has to say so for the documented bypass to be accepted.
      NODE_ENV: "development",
      APP_URL: "http://localhost:5200",
      INTEGRATIONS: "mock",
      TOKEN_ENC_KEY: KEY,
      DEV_USER_EMAIL: "rep@example.com",
      ZOHO_CRM_BASE_URL: "https://crm.zoho.eu/crm/org12345",
    });
    expect(parsed.INTEGRATIONS).toBe("mock");
    expect(parsed.APP_URL).toBe("http://localhost:5200");
    expect(parsed.DEV_USER_EMAIL).toBe("rep@example.com");
  });

  it("defaults INTEGRATIONS to mock, and NODE_ENV to production rather than development", () => {
    // Each default is the safe end of its own field: a mock integration talks
    // to nobody, and an unidentified environment is treated as a live one.
    const parsed = parseEnv(base());
    expect(parsed.INTEGRATIONS).toBe("mock");
    expect(parsed.NODE_ENV).toBe("production");
  });

  it("refuses a missing DATABASE_URL", () => {
    expect(() => parseEnv({ DIRECT_URL: base().DIRECT_URL })).toThrow(/DATABASE_URL/);
  });

  it("refuses an empty DATABASE_URL rather than passing it to Prisma", () => {
    expect(() => parseEnv({ ...base(), DATABASE_URL: "" })).toThrow(/DATABASE_URL/);
  });

  it("refuses DEV_USER_EMAIL in production: it is a sign-in bypass", () => {
    expect(() =>
      parseEnv({ ...base(), NODE_ENV: "production", DEV_USER_EMAIL: "rep@example.com" }),
    ).toThrow(/local-only bypass/);
  });

  it("allows DEV_USER_EMAIL during a production build, which serves no request", () => {
    // `next build` sets NODE_ENV=production and reads the developer's local
    // env file. Refusing here would kill `npm run build` on every machine that
    // has the documented bypass filled in.
    expect(() =>
      parseEnv({
        ...base(),
        NODE_ENV: "production",
        DEV_USER_EMAIL: "rep@example.com",
        NEXT_PHASE: "phase-production-build",
      }),
    ).not.toThrow();
  });

  it("still refuses DEV_USER_EMAIL on a production server, build phase or not", () => {
    for (const NEXT_PHASE of [undefined, "phase-production-server"]) {
      expect(() =>
        parseEnv({
          ...base(),
          NODE_ENV: "production",
          DEV_USER_EMAIL: "rep@example.com",
          NEXT_PHASE,
        }),
      ).toThrow(/local-only bypass/);
    }
  });

  it("reads the build phase from its argument, not from ambient process.env", () => {
    // Otherwise validating a candidate environment silently loses the guard.
    const saved = process.env.NEXT_PHASE;
    process.env.NEXT_PHASE = "phase-production-build";
    try {
      expect(() =>
        parseEnv({ ...base(), NODE_ENV: "production", DEV_USER_EMAIL: "rep@example.com" }),
      ).toThrow(/local-only bypass/);
    } finally {
      if (saved === undefined) delete process.env.NEXT_PHASE;
      else process.env.NEXT_PHASE = saved;
    }
  });

  it("takes the default when a variable is defined but blank", () => {
    // A Vercel env var saved empty arrives as "", not as absent.
    const parsed = parseEnv({ ...base(), INTEGRATIONS: "", NODE_ENV: "" });
    expect(parsed.INTEGRATIONS).toBe("mock");
    expect(parsed.NODE_ENV).toBe("production");
  });

  it("refuses a connection string that is not one", () => {
    for (const bad of ["   ", "relay", "http://example.com/db", "postgres"]) {
      expect(() => parseEnv({ ...base(), DATABASE_URL: bad }), bad).toThrow(/DATABASE_URL/);
    }
  });

  it("returns a connection string trimmed, not merely validated trimmed", () => {
    // The refine parses a trimmed copy; what callers get has to be that copy.
    const padded = "  postgresql://relay:relay@127.0.0.1:5435/relay  ";
    const parsed = parseEnv({ ...base(), DATABASE_URL: padded, DIRECT_URL: padded });
    expect(parsed.DATABASE_URL).toBe("postgresql://relay:relay@127.0.0.1:5435/relay");
    expect(parsed.DIRECT_URL).toBe("postgresql://relay:relay@127.0.0.1:5435/relay");
  });

  it("accepts the connection-string shapes the stack uses", () => {
    for (const good of [
      "postgresql://relay:relay@127.0.0.1:5435/relay",
      "postgres://relay:relay@127.0.0.1:5435/relay",
      "prisma://accelerate.prisma-data.net/?api_key=x",
    ]) {
      expect(() => parseEnv({ ...base(), DATABASE_URL: good }), good).not.toThrow();
    }
  });

  it("refuses an APP_URL whose scheme a browser will not follow", () => {
    expect(() => parseEnv({ ...base(), APP_URL: "ftp://example.com" })).toThrow(/APP_URL/);
    expect(() => parseEnv({ ...base(), APP_URL: "javascript:alert(1)" })).toThrow(/APP_URL/);
  });

  it("allows DEV_USER_EMAIL when the environment says it is development or test", () => {
    for (const NODE_ENV of ["development", "test"]) {
      expect(() =>
        parseEnv({ ...base(), NODE_ENV, DEV_USER_EMAIL: "rep@example.com" }),
        NODE_ENV,
      ).not.toThrow();
    }
  });

  it("refuses DEV_USER_EMAIL when NODE_ENV is unset: silence is not development", () => {
    // The worker is a bare Node process; nothing sets NODE_ENV for it. An
    // operator who leaves it out of a unit file must not get the bypass.
    expect(() =>
      parseEnv({ ...base(), NODE_ENV: undefined, DEV_USER_EMAIL: "rep@example.com" }),
    ).toThrow(/local-only bypass/);
  });

  it("refuses DEV_USER_EMAIL when NODE_ENV is blank", () => {
    expect(() =>
      parseEnv({ ...base(), NODE_ENV: "", DEV_USER_EMAIL: "rep@example.com" }),
    ).toThrow(/local-only bypass/);
  });

  it("refuses a DEV_USER_EMAIL that is not an email address", () => {
    expect(() => parseEnv({ ...base(), DEV_USER_EMAIL: "rep" })).toThrow(/DEV_USER_EMAIL/);
  });

  it("requires TOKEN_ENC_KEY once integrations are live", () => {
    expect(() => parseEnv({ ...base(), INTEGRATIONS: "live" })).toThrow(/TOKEN_ENC_KEY/);
  });

  it("accepts live integrations with a key", () => {
    const parsed = parseEnv({ ...base(), INTEGRATIONS: "live", TOKEN_ENC_KEY: KEY });
    expect(parsed.TOKEN_ENC_KEY).toBe(KEY);
  });

  it("accepts mock integrations without a key", () => {
    expect(parseEnv({ ...base(), INTEGRATIONS: "mock" }).TOKEN_ENC_KEY).toBeUndefined();
  });

  it("treats an empty TOKEN_ENC_KEY as unset, because that is what the template ships", () => {
    expect(parseEnv({ ...base(), TOKEN_ENC_KEY: "" }).TOKEN_ENC_KEY).toBeUndefined();
    expect(() => parseEnv({ ...base(), INTEGRATIONS: "live", TOKEN_ENC_KEY: "" })).toThrow(
      /TOKEN_ENC_KEY/,
    );
  });

  it("trims a TOKEN_ENC_KEY rather than failing it as non-base64", () => {
    // `openssl rand -base64 32 > key` leaves a trailing newline, and a value
    // pasted into a dashboard often keeps one.
    expect(parseEnv({ ...base(), TOKEN_ENC_KEY: `${KEY}\n` }).TOKEN_ENC_KEY).toBe(KEY);
    expect(parseEnv({ ...base(), TOKEN_ENC_KEY: `  ${KEY}  ` }).TOKEN_ENC_KEY).toBe(KEY);
  });

  it("refuses a TOKEN_ENC_KEY that does not decode to 32 bytes", () => {
    expect(() =>
      parseEnv({ ...base(), TOKEN_ENC_KEY: randomBytes(31).toString("base64") }),
    ).toThrow(/32/);
    expect(() =>
      parseEnv({ ...base(), TOKEN_ENC_KEY: randomBytes(33).toString("base64") }),
    ).toThrow(/32/);
  });

  it("refuses a TOKEN_ENC_KEY that is not base64 at all", () => {
    // Buffer.from() silently drops characters outside the alphabet, so a
    // 32-byte length check alone would accept this.
    expect(() => parseEnv({ ...base(), TOKEN_ENC_KEY: "not a key!!!" })).toThrow(/base64/);
  });

  it("refuses an APP_URL that is not a URL", () => {
    expect(() => parseEnv({ ...base(), APP_URL: "localhost:5200" })).toThrow(/APP_URL/);
  });

  it("refuses an INTEGRATIONS value that is neither mock nor live", () => {
    expect(() => parseEnv({ ...base(), INTEGRATIONS: "real" })).toThrow(/INTEGRATIONS/);
  });

  it("ignores variables it does not know about", () => {
    expect(() => parseEnv({ ...base(), SOMETHING_ELSE: "x" })).not.toThrow();
  });
});

describe("env", () => {
  const saved = { ...process.env };

  afterEach(() => {
    process.env = { ...saved };
    resetEnv();
  });

  it("reads process.env and memoises the result", () => {
    resetEnv();
    expect(env()).toBe(env());
  });

  it("re-reads process.env after resetEnv", () => {
    resetEnv();
    const before = env().INTEGRATIONS;
    process.env.INTEGRATIONS = before === "mock" ? "live" : "mock";
    process.env.TOKEN_ENC_KEY = KEY;
    expect(env().INTEGRATIONS).toBe(before);
    resetEnv();
    expect(env().INTEGRATIONS).not.toBe(before);
  });
});

describe("parseEnv and the worker's timing knobs", () => {
  const KNOBS = [
    ["RELAY_WORKER_POLL_MS", 2_000],
    ["RELAY_WORKER_LEASE_MS", 120_000],
    ["RELAY_WORKER_DRAIN_MS", 540_000],
  ] as const;

  it.each(KNOBS)("%s defaults when it is unset", (name, fallback) => {
    expect(parseEnv(base())[name]).toBe(fallback);
  });

  it.each(KNOBS)("%s folds a defined-but-blank value to the default", (name, fallback) => {
    // Deliberate, and the reason `positiveMs` exists: `z.coerce.number()` is
    // `Number()`, which reads `""` as 0 — a zero-millisecond poll interval is
    // a worker spinning a database round trip as fast as the event loop
    // allows. A blank variable is an operator who set nothing, so it gets the
    // shipping value rather than a boot failure.
    expect(parseEnv({ ...base(), [name]: "" })[name]).toBe(fallback);
  });

  it.each(KNOBS)("%s refuses whitespace, which is set-wrong rather than unset", (name) => {
    // The fold is `""` and nothing else. `Number("  ")` is 0, so this fails
    // `.positive()` and stops the boot with the variable's name — which is the
    // right answer for a value somebody typed rather than left alone.
    expect(() => parseEnv({ ...base(), [name]: "   " })).toThrow(new RegExp(name));
  });

  it.each(KNOBS)("%s refuses zero, which would busy-loop the database", (name) => {
    expect(() => parseEnv({ ...base(), [name]: "0" })).toThrow(new RegExp(name));
  });

  it.each(KNOBS)("%s refuses a negative interval", (name) => {
    expect(() => parseEnv({ ...base(), [name]: "-1" })).toThrow(new RegExp(name));
  });

  it.each(KNOBS)("%s refuses a value that is not a number", (name) => {
    expect(() => parseEnv({ ...base(), [name]: "abc" })).toThrow(new RegExp(name));
  });

  it.each(KNOBS)("%s refuses a fraction of a millisecond", (name) => {
    expect(() => parseEnv({ ...base(), [name]: "1.5" })).toThrow(new RegExp(name));
  });

  it.each(KNOBS)("%s accepts a whole number of milliseconds", (name) => {
    expect(parseEnv({ ...base(), [name]: "2000" })[name]).toBe(2_000);
  });
});
