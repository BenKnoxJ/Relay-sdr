import { afterEach, describe, expect, it } from "vitest";

import { parseEnv, resetEnv } from "@/lib/env";
import { NO_CRM } from "@/lib/leadgen/crm";
import { findPeople } from "@/lib/leadgen/findPeople";
import { sampleProvider, sampleVocabulary } from "@/lib/leadgen/sample";
import { leadGenSetup } from "@/lib/leadgen/setup";

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
