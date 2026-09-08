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

  it("defaults INTEGRATIONS to mock and NODE_ENV to development", () => {
    const parsed = parseEnv(base());
    expect(parsed.INTEGRATIONS).toBe("mock");
    expect(parsed.NODE_ENV).toBe("development");
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
    const saved = process.env.NEXT_PHASE;
    process.env.NEXT_PHASE = "phase-production-build";
    try {
      expect(() =>
        parseEnv({ ...base(), NODE_ENV: "production", DEV_USER_EMAIL: "rep@example.com" }),
      ).not.toThrow();
    } finally {
      if (saved === undefined) delete process.env.NEXT_PHASE;
      else process.env.NEXT_PHASE = saved;
    }
  });

  it("still refuses DEV_USER_EMAIL on a production server, build phase or not", () => {
    const saved = process.env.NEXT_PHASE;
    for (const phase of [undefined, "phase-production-server"]) {
      if (phase === undefined) delete process.env.NEXT_PHASE;
      else process.env.NEXT_PHASE = phase;
      expect(() =>
        parseEnv({ ...base(), NODE_ENV: "production", DEV_USER_EMAIL: "rep@example.com" }),
      ).toThrow(/local-only bypass/);
    }
    if (saved === undefined) delete process.env.NEXT_PHASE;
    else process.env.NEXT_PHASE = saved;
  });

  it("refuses an APP_URL whose scheme a browser will not follow", () => {
    expect(() => parseEnv({ ...base(), APP_URL: "ftp://example.com" })).toThrow(/APP_URL/);
    expect(() => parseEnv({ ...base(), APP_URL: "javascript:alert(1)" })).toThrow(/APP_URL/);
  });

  it("allows DEV_USER_EMAIL outside production", () => {
    expect(() =>
      parseEnv({ ...base(), NODE_ENV: "development", DEV_USER_EMAIL: "rep@example.com" }),
    ).not.toThrow();
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
