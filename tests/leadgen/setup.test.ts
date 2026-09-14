import { afterEach, describe, expect, it } from "vitest";

import { parseEnv, resetEnv } from "@/lib/env";
import { NO_CRM } from "@/lib/leadgen/crm";
import { findPeople } from "@/lib/leadgen/findPeople";
import { sampleProvider, sampleVocabulary } from "@/lib/leadgen/sample";
import { leadGenSetup } from "@/lib/leadgen/setup";
import { LUSHA_V3_PRICING } from "@/lib/leadgen/spend";

import { NO_WAIT, handoff, knowledge } from "./harness";

/**
 * How finding people is set up: off unless the sample is switched on, the
 * sample refused in production, and never a hidden fallback to sample people.
 */

const base = () => ({
  DATABASE_URL: "postgresql://relay:relay@127.0.0.1:5435/relay",
  DIRECT_URL: "postgresql://relay:relay@127.0.0.1:5435/relay",
});

afterEach(() => {
  delete process.env.RELAY_LEADGEN_PROVIDER;
  delete process.env.RELAY_LEADGEN_SEARCH_CAP;
  resetEnv();
});

describe("leadGenSetup", () => {
  it("is off unless the sample is switched on: nothing falls back to sample people", () => {
    resetEnv();
    expect(leadGenSetup()).toBeNull();
  });

  it("gives sample credits, labelled as samples, and the configured cap", async () => {
    process.env.RELAY_LEADGEN_PROVIDER = "sample";
    process.env.RELAY_LEADGEN_SEARCH_CAP = "60";
    resetEnv();
    const setup = leadGenSetup();
    expect(setup).toMatchObject({ sample: true, searchCreditCap: 60 });
    expect(await setup!.readBalance("org")).toMatchObject({ source: "sample" });
  });

  it("is refused at boot in production", () => {
    expect(() => parseEnv({ ...base(), NODE_ENV: "production", RELAY_LEADGEN_PROVIDER: "sample" })).toThrow(/RELAY_LEADGEN_PROVIDER/);
    expect(parseEnv({ ...base(), NODE_ENV: "development", RELAY_LEADGEN_PROVIDER: "sample" }).RELAY_LEADGEN_PROVIDER).toBe("sample");
  });
});

describe("the Lusha setup", () => {
  const lusha = (over: Record<string, string> = {}) => ({ ...base(), NODE_ENV: "development", RELAY_LEADGEN_PROVIDER: "lusha", RELAY_LEADGEN_SEARCH_CAP: "40", ...over });

  it("needs an explicit search limit, and a key when it is live", () => {
    expect(() => parseEnv({ ...lusha(), RELAY_LEADGEN_SEARCH_CAP: "" })).toThrow(/RELAY_LEADGEN_SEARCH_CAP is required/);
    expect(() => parseEnv(lusha({ INTEGRATIONS: "live", TOKEN_ENC_KEY: Buffer.alloc(32).toString("base64") }))).toThrow(/LUSHA_API_KEY is required/);
    expect(parseEnv(lusha({ INTEGRATIONS: "live", TOKEN_ENC_KEY: Buffer.alloc(32).toString("base64"), LUSHA_API_KEY: "k" })).RELAY_LEADGEN_PROVIDER).toBe("lusha");
  });

  it("@proof never replays recorded people in production, and is accepted there live", () => {
    expect(() => parseEnv(lusha({ NODE_ENV: "production", INTEGRATIONS: "mock" }))).toThrow(/INTEGRATIONS=mock replays recorded people/);
    // Unset INTEGRATIONS is mock: production has to say live.
    expect(() => parseEnv(lusha({ NODE_ENV: "production" }))).toThrow(/INTEGRATIONS=mock/);
    const live = parseEnv(lusha({ NODE_ENV: "production", INTEGRATIONS: "live", TOKEN_ENC_KEY: Buffer.alloc(32).toString("base64"), LUSHA_API_KEY: "k" }));
    expect(live.RELAY_LEADGEN_PROVIDER).toBe("lusha");
    expect(() => parseEnv({ ...base(), NODE_ENV: "production", RELAY_LEADGEN_PROVIDER: "sample" })).toThrow(/RELAY_LEADGEN_PROVIDER=sample/);
  });

  it("is not a sample, freezes the Lusha pricing model, and reads a live balance", async () => {
    process.env.RELAY_LEADGEN_PROVIDER = "lusha";
    process.env.RELAY_LEADGEN_SEARCH_CAP = "40";
    const integrations = process.env.INTEGRATIONS;
    process.env.INTEGRATIONS = "mock";
    try {
      resetEnv();
      const setup = leadGenSetup();
      expect(setup).toMatchObject({ sample: false, searchCreditCap: 40, pricingAssumptions: LUSHA_V3_PRICING.id, pricing: LUSHA_V3_PRICING });
      expect(await setup!.readBalance("org")).toMatchObject({ remaining: 900, source: "live" });
      expect((await setup!.environment(handoff())).vocabulary.version).toBe("lusha-v3");
    } finally {
      if (integrations === undefined) delete process.env.INTEGRATIONS;
      else process.env.INTEGRATIONS = integrations;
    }
  });
});

describe("the sample environment", () => {
  it("finds made-up people on .example domains for any handoff, with no network", async () => {
    const research = handoff();
    const result = await findPeople(research, {
      provider: sampleProvider(research),
      vocabulary: sampleVocabulary(research),
      knowledge: knowledge(),
      crm: NO_CRM,
      retry: NO_WAIT,
    });
    expect(result.output.phase).toBe("pick");
    if (result.output.phase === "pick") {
      expect(result.output.chosen.length).toBeGreaterThan(0);
      for (const person of result.output.chosen) expect(person.domain?.endsWith(".example")).toBe(true);
    }
  });
});
