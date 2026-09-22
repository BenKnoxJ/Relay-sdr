import { describe, expect, it } from "vitest";

import { senderOf } from "@/lib/outreach/adapter";

/**
 * Who is writing (P5c): the drafter is told the rep's first name and their
 * company, so a call opener, voicemail or connection note introduces them as
 * "<first name> from <company>" instead of inventing someone.
 */
describe("the sender", () => {
  it("is the rep's first name and the org's display name", () => {
    expect(senderOf({ userName: "Ben Knox-Johnston", email: "ben.knox-johnston@conversant.technology", orgName: "Conversant Group" })).toEqual({ firstName: "Ben", company: "Conversant Group" });
  });

  it("is Conversant while the org's name is still its email domain", () => {
    expect(senderOf({ userName: "Sam Carter", email: "sam@conversant.technology", orgName: "conversant.technology" })).toEqual({ firstName: "Sam", company: "Conversant" });
    expect(senderOf({ userName: "Sam Carter", email: "sam@example.co.uk", orgName: "  " })).toEqual({ firstName: "Sam", company: "Conversant" });
    expect(senderOf({ userName: "Sam Carter", email: "sam@example.co.uk", orgName: null })).toEqual({ firstName: "Sam", company: "Conversant" });
  });

  it("takes the first name from the email when the user record has no name", () => {
    expect(senderOf({ userName: null, email: "ben.knox-johnston@conversant.technology", orgName: "conversant.technology" })).toEqual({ firstName: "Ben", company: "Conversant" });
    expect(senderOf({ userName: "  ", email: "SAM@example.test", orgName: "example.test" })).toEqual({ firstName: "Sam", company: "Conversant" });
    // A local part that opens on punctuation still gives a name, never an empty one the input would refuse.
    expect(senderOf({ userName: null, email: "_sam@acme.co.uk", orgName: null }).firstName).toBe("Sam");
    expect(senderOf({ userName: null, email: "._@acme.co.uk", orgName: null }).firstName).toBe("._");
  });
});

describe("the facts a draft is written from (P5c)", () => {
  it("carry no machine word a rep would repeat to a prospect", async () => {
    const { loadFacts } = await import("@/lib/facts/load");
    const facts = loadFacts("insights360", 2).facts.facts.filter((fact) => fact.status === "live");
    const leaks = facts.flatMap((fact) => [fact.text, fact.notes ?? ""].filter((text) => /\b(pipelines?|ingest\w*|tenants?|relay)\b/i.test(text)).map((text) => `${fact.id}: ${text}`));
    expect(leaks).toEqual([]);
  });

  it("say 'every call, not a sample', and the never-say list offers the same", async () => {
    const { loadFacts } = await import("@/lib/facts/load");
    const fact = loadFacts("insights360", 2).facts.facts.find((candidate) => candidate.id === "i360.product.every-ingested-call-analysed")!;
    expect(fact.text).toBe("Every call that comes in is transcribed and scored, not a sample.");
    const neverSay = (await import("../../facts/insights360.v2.never-say.json")).default as { entries: { id: string; sayInstead: string }[] };
    expect(neverSay.entries.find((entry) => entry.id === "every-call-absolute")?.sayInstead).toBe("every call, not a sample");
    expect(neverSay.entries.filter((entry) => /\b(pipelines?|ingest\w*)\b/i.test(entry.sayInstead))).toEqual([]);
  });
});

describe("what the drafter is told (P5c)", () => {
  it("never names Relay as the one adding the greeting, and asks for the rep's introduction", async () => {
    const { readFileSync } = await import("node:fs");
    const read = (file: string) => readFileSync(new URL(`../../agents/outreach/${file}`, import.meta.url), "utf8");
    const { loadStandard } = await import("@/lib/outreach/standard");
    const standard = loadStandard();
    for (const text of [read("prompt.md"), read("humanizer.md"), ...standard.rules]) expect(text).not.toMatch(/Relay adds/);
    expect(read("prompt.md")).toMatch(/introduce the rep as "<sender first name> from <sender company>"/);
    expect(standard.bannedLexicon).toEqual(expect.arrayContaining(["relay", "pipeline"]));
  });
});
