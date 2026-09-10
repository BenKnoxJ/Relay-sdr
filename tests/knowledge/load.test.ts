import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { KNOWLEDGE_ARTICLES, KNOWLEDGE_SCRUB, knowledgeHash, knowledgePath, loadKnowledge } from "@/lib/knowledge/load";

/**
 * The product knowledge set is code (research v3 §4): versioned, hashed,
 * shipped with the repository, scrubbed of the fleet's names and this VPS's
 * paths. This is its contract.
 */

describe("the Insights360 knowledge set", () => {
  const loaded = loadKnowledge("insights360", 1);

  it("parses its manifest, names every article the definition lists, and reads them all", () => {
    expect(loaded.manifest.product).toBe("insights360");
    expect(loaded.manifest.version).toBe(1);
    expect(loaded.path).toBe(knowledgePath("insights360", 1));
    expect([...loaded.manifest.articles].sort()).toEqual([...KNOWLEDGE_ARTICLES].sort());
    for (const name of KNOWLEDGE_ARTICLES) expect(loaded.articles.get(name)?.length ?? 0).toBeGreaterThan(500);
  });

  it("ships nothing but the manifest and the named articles", () => {
    const files = readdirSync(loaded.path).sort();
    expect(files).toEqual(["manifest.json", ...KNOWLEDGE_ARTICLES.map((name) => `${name}.md`)].sort());
  });

  it("hashes the content, not the bytes' order on disk, and moves when an article changes", () => {
    const again = loadKnowledge("insights360", 1);
    expect(again.hash).toBe(loaded.hash);
    const edited = new Map(loaded.articles);
    edited.set("overview", `${edited.get("overview")}\nchanged`);
    expect(knowledgeHash(loaded.manifest, edited)).not.toBe(loaded.hash);
  });

  it("carries a roadmap with a shipped status the solution-mapping module can read", () => {
    expect(loaded.articles.get("roadmap")).toMatch(/shipped/i);
  });

  it("is scrubbed: no fleet codename, no VPS path, no owner's name in any article", () => {
    for (const name of KNOWLEDGE_ARTICLES) {
      const text = readFileSync(path.join(loaded.path, `${name}.md`), "utf8");
      const hit = KNOWLEDGE_SCRUB.exec(text);
      expect(hit, `${name}.md: ${hit?.[0]} at ${hit?.index}`).toBeNull();
    }
  });

  it("refuses a product or version it does not hold", () => {
    expect(() => loadKnowledge("insights360", 2)).toThrow(/no knowledge set/);
    expect(() => loadKnowledge("Insights 360", 1)).toThrow(/plain slug/);
  });
});
