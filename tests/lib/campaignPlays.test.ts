import { describe, expect, it } from "vitest";

import { completeModule } from "../../agents/research/output.schema";
import { defaultPlayId, executablePlayCount, playFactsOf, playsOf, rankedPlays } from "@/lib/campaigns/plays";
import { topCandidate } from "@/lib/campaigns/packSelectors";

import { completePack, partialPack, playablePartialPack, stoppedPack } from "./campaignPacks";

/**
 * Research's plays as the campaign boundary reads them (product-truth
 * foundation): every usable candidate, best first, which can be confirmed,
 * and the words the rep compares them by. Read from the pack; nothing is
 * normalised out of it.
 */

describe("rankedPlays", () => {
  it("returns every play research ranked for a kind of buyer it describes, best first, each executable where it has a recipe", () => {
    const pack = completePack();
    const plays = rankedPlays(playFactsOf(pack));
    expect(plays.map((play) => play.rank)).toEqual([1, 2, 3]);
    expect(plays.every((play) => play.executable)).toBe(true);
    expect(plays.map((play) => play.id)).toEqual(
      completeModule(pack, "m16")!.candidates.slice().sort((a, b) => a.rank - b.rank).map((candidate) => candidate.id),
    );
    expect(defaultPlayId(playFactsOf(pack))).toBe(topCandidate(pack)?.id);
  });

  it("keeps research's own order on a tie, drops a play for a group the pack does not describe, and marks one without a recipe", () => {
    const facts = {
      archetypeIds: ["a", "b", "c"],
      recipeArchetypeIds: ["a", "c"],
      candidates: [
        { id: "p-b", rank: 2, archetypeId: "b" },
        { id: "p-a", rank: 1, archetypeId: "a" },
        { id: "p-c", rank: 2, archetypeId: "c" },
        { id: "p-x", rank: 1, archetypeId: "not-described" },
      ],
    };
    expect(rankedPlays(facts)).toEqual([
      { id: "p-a", rank: 1, archetypeId: "a", executable: true },
      { id: "p-b", rank: 2, archetypeId: "b", executable: false },
      { id: "p-c", rank: 2, archetypeId: "c", executable: true },
    ]);
    expect(executablePlayCount(facts)).toBe(2);
    expect(executablePlayCount({ ...facts, recipeArchetypeIds: [] })).toBe(0);
  });

  it("has nothing to confirm on brief B's partial run, which wrote no plays, and on a stop", () => {
    expect(executablePlayCount(playFactsOf(partialPack()))).toBe(0);
    expect(playsOf(stoppedPack())).toEqual([]);
    expect(executablePlayCount(playFactsOf(playablePartialPack()))).toBe(3);
  });
});

describe("playsOf", () => {
  it("gives the rep each play in research's words, with its group, roles and named firms, and no internal names", () => {
    const pack = completePack();
    const plays = playsOf(pack);
    expect(plays).toHaveLength(3);
    expect(plays.filter((play) => play.recommended).map((play) => play.rank)).toEqual([1]);
    for (const play of plays) {
      expect(play.group.name.length).toBeGreaterThan(0);
      expect(play.leadAngle.length).toBeGreaterThan(0);
      expect(play.whyNow.length).toBeGreaterThan(0);
      expect(play.wrongIf.length).toBeGreaterThan(0);
      expect(play.channels.length).toBeGreaterThan(0);
      expect(play.roles.length).toBeGreaterThan(0);
      expect(play.groupSeedFirms).toBeGreaterThan(0);
      expect(play.executable).toBe(true);
      // No module ids, fact ids or pack structure reach a rep.
      expect(JSON.stringify([play.leadAngle, play.whyNow, play.wrongIf])).not.toMatch(/\bm[01]\d\b|i360\./);
      expect(Object.keys(play).sort()).toEqual(["channels", "executable", "group", "groupSeedFirms", "id", "leadAngle", "rank", "recommended", "roles", "seedFirms", "whyNow", "wrongIf"]);
    }
  });
});
