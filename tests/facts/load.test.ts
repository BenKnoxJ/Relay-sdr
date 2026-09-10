import { describe, expect, it } from "vitest";

import { productFactsSchema } from "../../agents/research/input.schema";
import { factsHash, factsPath, loadFacts } from "@/lib/facts/load";
import { factsFileSchema, liveFactIds, toProductFacts } from "@/lib/facts/schema";

/**
 * The facts file is code, and this is its contract.
 *
 * Task 11. The file in `facts/` is the draft until the product owner signs it; the
 * loader says so on every run that cites it, and everything else — the ids,
 * the shape the agents receive, the hash — is the same either way, so that the
 * signature changes one status field and the hash, and nothing about the build.
 */

describe("the Insights360 facts file", () => {
  const loaded = loadFacts("insights360", 1);

  it("parses, names itself, and is signed (product owner, 2026-09-10)", () => {
    expect(loaded.file.product).toBe("insights360");
    expect(loaded.file.version).toBe(1);
    expect(loaded.draft).toBe(false);
    expect(loaded.file).toMatchObject({ status: "signed", signedAt: "2026-09-10" });
    expect(loaded.path).toBe(factsPath("insights360", 1));
  });

  it("holds forty facts, thirty-three of them live, with unique dotted ids", () => {
    expect(loaded.file.facts).toHaveLength(40);
    expect(liveFactIds(loaded.facts).size).toBe(33);
    expect(new Set(loaded.file.facts.map((fact) => fact.id)).size).toBe(40);
    for (const fact of loaded.file.facts) expect(fact.id).toMatch(/^i360\.[a-z]+\.[a-z0-9-]+$/);
  });

  it("maps to the agents' shape with the claim as text and no source path", () => {
    const facts = toProductFacts(loaded.file);
    expect(productFactsSchema.safeParse(facts).success).toBe(true);
    expect(facts.facts[0]).toEqual({
      id: loaded.file.facts[0]!.id,
      status: loaded.file.facts[0]!.status,
      text: loaded.file.facts[0]!.claim,
      notes: loaded.file.facts[0]!.notes,
    });
    // A source is a path on the machine the fact was verified on: a reviewer's
    // evidence, and never something a model should see.
    expect(JSON.stringify(facts)).not.toContain("/home/");
  });

  it("hashes the content, not the formatting", () => {
    // The same file with every object's keys in reverse order, at every depth.
    const reverseKeys = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(reverseKeys);
      if (value !== null && typeof value === "object") {
        return Object.fromEntries(
          Object.entries(value as Record<string, unknown>)
            .reverse()
            .map(([key, inner]) => [key, reverseKeys(inner)]),
        );
      }
      return value;
    };
    const reordered = reverseKeys(loaded.file);
    expect(JSON.stringify(reordered)).not.toBe(JSON.stringify(loaded.file));
    expect(factsHash(factsFileSchema.parse(reordered))).toBe(loaded.hash);
    const edited = factsFileSchema.parse({
      ...loaded.file,
      facts: loaded.file.facts.map((fact, index) => (index === 0 ? { ...fact, claim: `${fact.claim} ` } : fact)),
    });
    expect(factsHash(edited)).not.toBe(loaded.hash);
    expect(loaded.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("refuses a file that is not there, and a product that is not a slug", () => {
    expect(() => loadFacts("insights360", 99)).toThrow(/no facts file/);
    expect(() => loadFacts("../etc", 1)).toThrow(/not a plain slug/);
  });

  it("refuses a duplicate id and a signed file with no signing date", () => {
    const base = loaded.file;
    const duplicate = { ...base, facts: [base.facts[0]!, base.facts[0]!] };
    expect(factsFileSchema.safeParse(duplicate).success).toBe(false);
    const signedWithoutDate = { ...base, status: "signed", signedAt: undefined };
    expect(factsFileSchema.safeParse(signedWithoutDate).success).toBe(false);
    const signed = { ...base, status: "signed", signedAt: "2026-09-10" };
    expect(factsFileSchema.safeParse(signed).success).toBe(true);
  });
});
