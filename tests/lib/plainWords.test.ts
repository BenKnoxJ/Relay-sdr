import { describe, it, expect } from "vitest";

import {
  MACHINE_WORDS,
  BANNED_DASHES,
  assertPlainWords,
  assertPlainDashes,
} from "@/lib/copy/plainWords";

describe("MACHINE_WORDS", () => {
  it("catches the machine vocabulary, singular and plural", () => {
    for (const word of [
      "orchestrator",
      "specialist",
      "agent run",
      "agent runs",
      "run id",
      "job",
      "jobs",
      "enrolment",
      "enrolments",
      "touch",
      "touches",
      "cohort",
      "persona",
      "personas",
      "archetype",
      "gate",
      "judge",
      "verdict",
      "autopilot",
      "stage",
      "module",
      "ICP",
      "pipeline",
      "payload",
      "prompt",
      "token",
      "tokens",
      "LLM",
      "model",
    ]) {
      expect(MACHINE_WORDS.test(`before ${word} after`), word).toBe(true);
    }
  });

  it("catches an agent's codename", () => {
    for (const name of [
      "Signal",
      "Pitch",
      "Prism",
      "Forge",
      "Critic",
      "Sentinel",
      "Scribe",
      "Neon",
      "Glitch",
      "Atlas",
      "Iris",
      "Vector",
      "Canvas",
    ]) {
      expect(MACHINE_WORDS.test(`ask ${name} about it`), name).toBe(true);
    }
  });

  it("leaves the rep words the signed screens use", () => {
    // These are machine words in Sales360's list and rep words here: they are
    // on the signed call card and in the sentences a rep reads (D1).
    for (const line of [
      "Log the outcome",
      "This sequence is paused",
      "Your campaign is running",
      "Draft a reply",
      "Book the call",
      "You have 3 credits left",
    ]) {
      expect(MACHINE_WORDS.test(line), line).toBe(false);
    }
  });

  it("matches whole words only", () => {
    for (const line of [
      "tokenise the sentence",
      "a gateway to nowhere",
      "prompting is not the word",
      "modelling clay",
      "stagecoach",
    ]) {
      expect(MACHINE_WORDS.test(line), line).toBe(false);
    }
  });

  it("is safe to reuse: no lastIndex state between calls", () => {
    // A /g regex would alternate true/false on the same input.
    expect(MACHINE_WORDS.test("one job")).toBe(true);
    expect(MACHINE_WORDS.test("one job")).toBe(true);
  });
});

describe("BANNED_DASHES", () => {
  it("refuses an em dash anywhere", () => {
    expect(BANNED_DASHES.test("Ready for you — open it")).toBe(true);
  });

  it("refuses an en dash used as punctuation", () => {
    expect(BANNED_DASHES.test("Ready – open it")).toBe(true);
    expect(BANNED_DASHES.test("Ready– open it")).toBe(true);
    expect(BANNED_DASHES.test("Ready –open it")).toBe(true);
  });

  it("allows an en dash inside a range", () => {
    expect(BANNED_DASHES.test("9–5 on weekdays")).toBe(false);
  });

  it("allows an ordinary hyphen", () => {
    expect(BANNED_DASHES.test("follow-up sent")).toBe(false);
  });
});

describe("assertPlainWords", () => {
  it("reads the values a rep sees, not the keys the code uses", () => {
    // `stage` is a machine word, but as a key it is never on screen.
    expect(() => assertPlainWords({ stage: "waiting on you" })).not.toThrow();
    expect(() => assertPlainWords({ cohort: { touch: ["Ready for you"] } })).not.toThrow();
  });

  it("refuses a machine word in anything a rep would read", () => {
    expect(() => assertPlainWords({ label: "the orchestrator drafted this" })).toThrow(
      /machine word/,
    );
    expect(() => assertPlainWords(["their enrolment is paused"])).toThrow(/machine word/);
    expect(() => assertPlainWords("the gate said no")).toThrow(/machine word/);
  });

  it("walks nested values and quotes the offending string", () => {
    expect(() => assertPlainWords({ sections: [{ rows: [{ note: "judge score 4" }] }] })).toThrow(
      /judge score 4/,
    );
  });

  it("lets a rep sentence through", () => {
    expect(() => assertPlainWords({ title: "Log the outcome", body: ["Book the call"] })).not.toThrow();
  });

  it("walks a Map's values and a Set's members, not only plain objects", () => {
    expect(() => assertPlainWords(new Map([["k", "their enrolment is paused"]]))).toThrow(
      /machine word/,
    );
    expect(() => assertPlainWords(new Set(["the gate said no"]))).toThrow(/machine word/);
  });

  it("ignores values a rep never reads", () => {
    expect(() => assertPlainWords({ count: 3, ok: true, missing: null })).not.toThrow();
  });
});

describe("assertPlainDashes", () => {
  it("refuses an em dash and quotes it", () => {
    expect(() => assertPlainDashes({ body: "Ready — open it" })).toThrow(/dash/);
  });

  it("lets a range through", () => {
    expect(() => assertPlainDashes({ body: "9–5 on weekdays" })).not.toThrow();
  });
});
