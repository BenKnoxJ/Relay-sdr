import { describe, expect, it } from "vitest";

import { researchOutputSchema, researchRawSchema } from "../../agents/research/output.schema";
import { loadFacts } from "@/lib/facts/load";
import { validatePack } from "@/lib/research/validate";

import { goodPack, mod } from "../agents/researchPack";

/**
 * Ingest, end to end (research v3 §7): the demotion the runtime does, the
 * strict pack parse, and the rules that need the run's input — live fact ids,
 * contact rules per channel, changes since a prior pack. Every issue names
 * its module, so the handler can re-ask that module alone.
 */

const facts = loadFacts("insights360", 1).facts;
const liveId = facts.facts.find((fact) => fact.status === "live")!.id;
const plannedId = facts.facts.find((fact) => fact.status === "planned")!.id;
const context = { facts, channels: ["email"], priorPackIds: [] as string[] };

describe("validatePack", () => {
  it("accepts the complete pack against the facts file", () => {
    const result = validatePack(goodPack({ liveFactId: liveId }), context);
    expect(result).toMatchObject({ ok: true, demoted: [] });
  });

  it("refuses a planned fact id wherever a module cites one, naming the module", () => {
    const pack = goodPack({ liveFactId: liveId });
    mod(pack, "m07").mappings[0]!.factIds = [liveId, plannedId];
    const result = validatePack(pack, context);
    if (result.ok) throw new Error("expected a refusal");
    expect(result.issues).toEqual([{ module: "m07", message: expect.stringContaining(plannedId) }]);
  });

  it("demotes a stale strong trigger to weak rather than refusing the pack", () => {
    const pack = goodPack({ liveFactId: liveId });
    const trigger = mod(pack, "m01").triggers[0]!;
    trigger.publishedAt = "2024-01-15";
    trigger.confidence = "strong";
    trigger.evidence.primary = true;
    expect(researchRawSchema.safeParse(pack).success).toBe(true);
    expect(researchOutputSchema.safeParse(pack).success).toBe(false);
    const result = validatePack(pack, context);
    if (!result.ok) throw new Error(result.issues.map((i) => i.message).join("; "));
    expect(mod(result.pack, "m01").triggers[0]!.confidence).toBe("weak");
    expect(result.demoted).toEqual([expect.stringMatching(/^m01\.triggers\.0 .*strong → weak$/)]);
  });

  it("needs a contact rule for every channel on the card", () => {
    const result = validatePack(goodPack({ liveFactId: liveId }), { ...context, channels: ["email", "linkedin"] });
    if (result.ok) throw new Error("expected a refusal");
    expect(result.issues).toEqual([{ module: "m12", message: 'm12: no contact rule for the channel "linkedin"' }]);
  });

  it("needs changes since the last pack when a prior pack was read", () => {
    const result = validatePack(goodPack({ liveFactId: liveId }), { ...context, priorPackIds: ["evt_prior"] });
    if (result.ok) throw new Error("expected a refusal");
    expect(result.issues[0]).toMatchObject({ module: "m14" });
  });

  it("names the module a pack-level rule refuses: every per-archetype module covers every kind of buyer", () => {
    const pack = goodPack({ liveFactId: liveId });
    mod(pack, "m05").perArchetype.pop();
    const result = validatePack(pack, context);
    if (result.ok) throw new Error("expected a refusal");
    expect(result.issues.some((i) => i.module === "m05" && /does not cover archetype/.test(i.message))).toBe(true);
  });

  it("accepts a partial pack whose missing modules are listed, and refuses one whose are not", () => {
    const pack = goodPack({ liveFactId: liveId });
    delete (pack.modules as Record<string, unknown>).m19;
    expect(validatePack(pack, context).ok).toBe(false);
    expect(validatePack({ ...pack, partial: true, missingModules: ["m19"] }, context).ok).toBe(true);
  });

  it("accepts a module stored insufficient, and skips the pack rules that would read it", () => {
    const pack = goodPack({ liveFactId: liveId });
    (pack.modules as Record<string, unknown>).m03 = { status: "insufficient", body: "Thin.", claims: [], issues: ["archetypes: needs 3"] };
    expect(validatePack(pack, context).ok).toBe(true);
  });
});
