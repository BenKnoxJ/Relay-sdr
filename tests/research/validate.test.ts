import { describe, expect, it } from "vitest";

import goodPack from "../../agents/research/fixtures/output.good.json";
import { researchOutputSchema, researchRawSchema } from "../../agents/research/output.schema";
import { loadFacts } from "@/lib/facts/load";
import { validatePack } from "@/lib/research/validate";

/**
 * Ingest, end to end: the raw parse the loop does, the demotion the runtime
 * does, the strict parse, and the facts rule.
 */

const facts = loadFacts("insights360", 1).facts;
const liveId = facts.facts.find((fact) => fact.status === "live")!.id;
const plannedId = facts.facts.find((fact) => fact.status === "planned")!.id;

function pack(): typeof goodPack {
  return structuredClone(goodPack);
}

describe("validatePack", () => {
  it("accepts the good fixture against the facts file", () => {
    const candidate = pack();
    candidate.hook.answeredBy = [liveId];
    const result = validatePack(candidate, { facts });
    expect(result.ok).toBe(true);
  });

  it("refuses a hook that cites a planned fact, by id", () => {
    const candidate = pack();
    candidate.hook.answeredBy = [liveId, plannedId];
    const result = validatePack(candidate, { facts });
    expect(result).toMatchObject({ ok: false });
    if (result.ok) throw new Error("unreachable");
    expect(result.issues[0]).toContain(plannedId);
  });

  it("demotes a stale strong whyNow to weak rather than rejecting the pack", () => {
    const candidate = pack();
    candidate.hook.answeredBy = [liveId];
    candidate.hook.whyNow.publishedAt = "2024-01-15";
    candidate.hook.whyNow.confidence = "strong";
    // Strong needs a primary source or three URLs over two domains; give it one
    // so the only thing wrong with it is its age.
    candidate.hook.whyNow.evidence.primary = true;
    // The loop's parse lets it through; the strict one would not.
    expect(researchRawSchema.safeParse(candidate).success).toBe(true);
    expect(researchOutputSchema.safeParse(candidate).success).toBe(false);
    const result = validatePack(candidate, { facts, now: new Date("2026-09-09") });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.pack.hook.whyNow.confidence).toBe("weak");
    expect(result.demoted).toEqual([expect.stringMatching(/^hook\.whyNow .*strong → weak$/)]);
  });

  it("waives the archetype and seed-firm minimums only when the pack is insufficient", () => {
    const thin = pack();
    thin.hook.answeredBy = [liveId];
    thin.archetypes = [thin.archetypes[0]!];
    thin.seedFirms = [];
    expect(researchRawSchema.safeParse(thin).success).toBe(false);
    const stopped = {
      ...thin,
      insufficient: {
        // New ids: every id in a pack is unique, and these are copies.
        found: thin.archetypes[0]!.pains.slice(0, 2).map((item, index) => ({ ...item, id: `found-${index}` })),
        widenings: [
          { kind: "region", text: "Widen to the whole of the UK" },
          { kind: "size", text: "Include firms up to 500 people" },
          { kind: "pain", text: "Name the pain you want to open on" },
        ],
      },
    };
    expect(researchRawSchema.safeParse(stopped).success).toBe(true);
    expect(validatePack(stopped, { facts }).ok).toBe(true);
  });
});
