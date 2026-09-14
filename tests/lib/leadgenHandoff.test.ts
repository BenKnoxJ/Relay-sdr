import { describe, expect, it } from "vitest";

import { researchBriefSchema } from "../../agents/research/input.schema";
import { chosenArchetypeId, leadgenRecipe, type PackShape } from "../../agents/research/output.schema";
import { leadGenHandoffV1Schema, leadGenHandoffV2Schema } from "../../agents/leadgen/input.schema";
import { buildLeadGenHandoff, type ConfirmFacts } from "@/lib/campaigns/leadgenHandoff";
import { topCandidate } from "@/lib/campaigns/packSelectors";

import { mod } from "../agents/researchPack";
import { completePack, partialPack, stoppedPack } from "./campaignPacks";

/**
 * The campaign boundary: signed Research output in, `LeadGenHandoffV2` out
 * (leadgen v2.1 §3, v2.2 §3a). H1 takes the top-ranked group and nothing
 * else, and copies that group's roles verbatim.
 */

const brief = researchBriefSchema.parse({
  product: "Insights360",
  motion: "direct",
  who: "Heads of claims at UK insurers",
  region: "GB",
  howMany: 20,
  weeks: 3,
  channels: ["email"],
  scope: {
    countries: ["GB"],
    places: [{ name: "Orkney", aliases: ["Orkney Islands"] }, { name: "Leeds" }],
    roles: { exclude: ["Claims Handler"] },
    excludeOrgTypes: ["brokers"],
    excludeFirms: [{ name: "Old Rival", domain: "oldrival.co.uk" }, { name: "Named Only" }],
  },
});

function facts(pack: PackShape, over: Partial<ConfirmFacts> = {}): ConfirmFacts {
  return {
    campaign: { id: "camp-1", orgId: "org-1", ownerUserId: "user-1", briefVersion: 2 },
    brief,
    research: { jobId: "job-9", eventId: "evt-9", pack },
    confirmRequestId: "req-1",
    spend: { searchCreditCap: 40, balanceSnapshot: { remaining: 120, readAt: "2026-09-14T09:00:00Z" }, pricingAssumptions: "lusha-public-docs-2026-09-14-unverified" },
    lawfulBasis: { text: "Legitimate interest: B2B offer, opt out in every email", confirmedByUserId: "user-1", confirmedAt: "2026-09-14T09:00:00Z", briefVersion: 2 },
    ...over,
  };
}

describe("buildLeadGenHandoff", () => {
  it("freezes the top-ranked group, its recipe and its seed firms, with the rank as provenance", () => {
    const pack = completePack();
    const result = buildLeadGenHandoff(facts(pack));
    if (!result.ok) throw new Error(result.refusal);
    const { handoff } = result;
    expect(leadGenHandoffV2Schema.safeParse(handoff).success).toBe(true);
    // V2 is not a V1: an old Confirm keeps its own version, and a new one is never read as the old.
    expect(leadGenHandoffV1Schema.safeParse(handoff).success).toBe(false);
    expect(handoff.version).toBe(2);
    expect(handoff.buyerGroup).toEqual({ id: "claims-teams", name: expect.any(String), sourceRank: 1 });
    expect(handoff.play).toEqual({ id: topCandidate(pack)?.id });
    // The confirmed group's roles, field for field: who signs it off, who runs it, and what each needs.
    expect(handoff.buyerRoles).toEqual([
      { title: "Head of claims", seniority: "Director", part: "signs", needs: "Proof for the board." },
      { title: "Claims team leader", seniority: "Manager", part: "runs", needs: "Less manual checking." },
    ]);
    expect(handoff.buyerGroup.id).toBe(topCandidate(pack)?.archetypeId);
    expect(handoff.targeting).toEqual({ ...leadgenRecipe(pack, "claims-teams"), locations: [] });
    expect(handoff.seedFirms.map((firm) => firm.name)).toEqual(["claims-teams firm 1", "claims-teams firm 2"]);
    expect(handoff.provenance).toEqual({ researchJobId: "job-9", researchEventId: "evt-9", outcome: "complete" });
    expect(handoff.campaign).toEqual({ id: "camp-1", orgId: "org-1", ownerUserId: "user-1", briefVersion: 2, confirmRequestId: "req-1" });
    expect(handoff.howMany).toBe(20);
  });

  it("copies the brief's places and exclusions explicitly", () => {
    const result = buildLeadGenHandoff(facts(completePack()));
    if (!result.ok) throw new Error(result.refusal);
    expect(result.handoff.places).toEqual([
      { name: "Orkney", aliases: ["Orkney Islands"] },
      { name: "Leeds", aliases: [] },
    ]);
    expect(result.handoff.exclusions).toEqual({
      firms: [{ name: "Old Rival", domain: "oldrival.co.uk" }, { name: "Named Only" }],
      roles: ["Claims Handler"],
      orgTypes: ["brokers"],
    });
  });

  it("refuses a pack with no ranked group, rather than falling back to the first group", () => {
    const pack = partialPack();
    // The derived view would fall back to a group; the boundary must not.
    expect(chosenArchetypeId(pack)).toBeDefined();
    expect(buildLeadGenHandoff(facts(pack))).toEqual({ ok: false, refusal: "no_ranked_group" });
  });

  it("refuses when the top-ranked group has no recipe, and does not swap in another group", () => {
    const pack = structuredClone(completePack());
    const m04 = mod(pack, "m04");
    m04.perArchetype = m04.perArchetype.filter((entry) => entry.archetypeId !== "claims-teams");
    expect(leadgenRecipe(pack, "regional-brokers")).toBeDefined();
    expect(buildLeadGenHandoff(facts(pack))).toEqual({ ok: false, refusal: "no_recipe" });
  });

  it("refuses a stopped pack: there is no plan to confirm", () => {
    expect(buildLeadGenHandoff(facts(stoppedPack()))).toEqual({ ok: false, refusal: "research_not_ready" });
  });

  it("will not build a handoff whose cap exceeds the balance, or whose lawful basis is for another version", () => {
    expect(() => buildLeadGenHandoff(facts(completePack(), { spend: { searchCreditCap: 200, balanceSnapshot: { remaining: 100, readAt: "2026-09-14T09:00:00Z" }, pricingAssumptions: "x" } }))).toThrow(/balance/);
    const lawful = facts(completePack()).lawfulBasis;
    expect(() => buildLeadGenHandoff(facts(completePack(), { lawfulBasis: { ...lawful, briefVersion: 1 } }))).toThrow(/brief version/);
  });
});
