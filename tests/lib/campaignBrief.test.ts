import { describe, expect, it } from "vitest";

import { lockScope } from "../../agents/research/output.schema";
import { applyScopePatch, briefFieldsFrom, briefFieldsSchema, nameFrom, sameBrief, toResearchBrief, widenedBrief, type ResearchBrief } from "@/lib/campaigns/brief";
import { becomesLine, widenHeadings } from "@/lib/campaigns/briefLines";
import { EMPTY_SCOPE } from "@/lib/campaigns/start";
import { campaignsCopy } from "@/lib/copy/campaigns";

import { briefFields, stoppedBrief, stoppedPack } from "./campaignPacks";

/**
 * Start's card as research's brief (research v3 §2, v3.2 note 28).
 *
 * The rule under test is the decision of 2026-09-12: only what the rep supplied
 * or confirmed reaches `brief.scope`, and `who` is their words unchanged.
 */
describe("toResearchBrief", () => {
  it("keeps who exactly as the rep left it, and sends no scope when nothing was added", () => {
    const who = "  Practice owners at independent vets in Orkney, the ones with 3+ sites ";
    const brief = toResearchBrief(briefFields({ who }));

    expect(brief.who).toBe(who);
    expect(brief).not.toHaveProperty("scope");
    expect(brief).not.toHaveProperty("existingCustomers");
    // Research still locks the region as the one country (lockScope's default).
    expect(lockScope(brief)).toMatchObject({ ok: true, scope: { countries: ["GB"], supplied: ["countries"] } });
  });

  it("sends each part of who exactly the rep added, trimmed and once", () => {
    const brief = toResearchBrief(
      briefFields({
        scope: {
          extraCountries: ["IE"],
          places: [
            { name: " Orkney ", aliases: ["Orkney Islands", " Kirkwall", "orkney islands", ""] },
            { name: "orkney", aliases: [] },
          ],
          orgTypes: ["veterinary practice", " Veterinary practice ", ""],
          size: { unit: "employees", min: 5, max: 50 },
          rolesInclude: ["practice owner"],
          rolesExclude: ["receptionist"],
        },
        existingCustomers: "  Two practices in Kirkwall, for their out of hours line. ",
      }),
    );

    expect(brief.region).toBe("GB");
    expect(brief.scope).toEqual({
      countries: ["GB", "IE"],
      places: [{ name: "Orkney", aliases: ["Orkney Islands", "Kirkwall"] }],
      orgTypes: ["veterinary practice"],
      size: { unit: "employees", min: 5, max: 50 },
      roles: { include: ["practice owner"], exclude: ["receptionist"] },
    });
    expect(brief.existingCustomers).toBe("Two practices in Kirkwall, for their out of hours line.");
  });

  it("never lists the region as an extra country, so the region alone sends no countries", () => {
    const brief = toResearchBrief(briefFields({ region: "IE", scope: { ...EMPTY_SCOPE, extraCountries: ["IE"] } }));
    expect(brief.scope).toBeUndefined();
  });

  it("leaves out a size with neither end, and one direction of roles when only the other is set", () => {
    const brief = toResearchBrief(
      briefFields({ scope: { ...EMPTY_SCOPE, size: { unit: "sites" }, rolesExclude: ["locum"] } }),
    );
    expect(brief.scope).toEqual({ roles: { exclude: ["locum"] } });
  });

  it("refuses a size that runs backwards, as research's own schema does", () => {
    expect(() => toResearchBrief(briefFields({ scope: { ...EMPTY_SCOPE, size: { unit: "employees", min: 50, max: 10 } } }))).toThrow();
  });

  it("keeps email on whatever the channels say", () => {
    expect(toResearchBrief(briefFields({ channels: ["linkedin"] })).channels).toEqual(["email", "linkedin"]);
  });

  it("round-trips the signed brief C through the card without changing what research is held to", () => {
    const signed = stoppedBrief() as ResearchBrief;
    const again = toResearchBrief(briefFieldsFrom(signed));
    const before = lockScope(signed);
    const after = lockScope(again);

    expect(after.ok && before.ok).toBe(true);
    if (after.ok && before.ok) {
      const { supplied: s1, ...scope1 } = before.scope;
      const { supplied: s2, ...scope2 } = after.scope;
      expect(scope2).toEqual(scope1);
      expect([...s2].sort()).toEqual([...s1].sort());
    }
    expect(again.who).toBe(signed.who);
  });
});

describe("briefFieldsSchema", () => {
  it("accepts only the values the card offers", () => {
    expect(briefFieldsSchema.safeParse(briefFields()).success).toBe(true);
    expect(briefFieldsSchema.safeParse(briefFields({ howMany: 15 })).success).toBe(false);
    expect(briefFieldsSchema.safeParse(briefFields({ weeks: 5 })).success).toBe(false);
    expect(briefFieldsSchema.safeParse({ ...briefFields(), region: "FR" }).success).toBe(false);
    expect(briefFieldsSchema.safeParse(briefFields({ product: "C360" })).success).toBe(false);
    expect(briefFieldsSchema.safeParse(briefFields({ who: "   " })).success).toBe(false);
  });
});

describe("nameFrom", () => {
  it("is the rep's words when they fit, cut at a word inside forty characters when not", () => {
    expect(nameFrom("Vets in Orkney")).toBe("Vets in Orkney");
    const name = nameFrom("Practice owners at independent vets in Orkney who run out of hours lines");
    expect(name.length).toBeLessThanOrEqual(40);
    expect(name).toBe("Practice owners at independent vets in");
    expect(nameFrom("x".repeat(60))).toBe("x".repeat(40));
  });
});

/**
 * A widening applied to a brief (research v3.2 note 28; orchestrator A1,
 * item 4), over the three real options of the signed brief C stop.
 */
describe("applyScopePatch and widenedBrief", () => {
  const C = () => stoppedBrief() as ResearchBrief;
  const options = () => stoppedPack().insufficient!.widenings;

  it("leaves a field the patch does not name, removes one it sets to null, and replaces the rest", () => {
    const [drop, islands, sector] = options();
    expect(applyScopePatch(C(), drop!.scopePatch).scope).toEqual({ countries: ["GB"], orgTypes: ["veterinary practice"] });
    expect(applyScopePatch(C(), islands!.scopePatch).scope).toEqual({ countries: ["GB"], places: islands!.scopePatch.places, orgTypes: ["veterinary practice"] });
    expect(applyScopePatch(C(), sector!.scopePatch).scope).toEqual({ countries: ["GB"], places: C().scope!.places });
    // Nothing else about the brief moves.
    const unscoped = (brief: ResearchBrief) => {
      const copy = { ...brief };
      delete copy.scope;
      return copy;
    };
    expect(unscoped(applyScopePatch(C(), drop!.scopePatch))).toEqual(unscoped(C()));
  });

  it("drops a scope left with nothing in it, as Start does", () => {
    const brief = toResearchBrief(briefFields({ scope: { ...EMPTY_SCOPE, orgTypes: ["veterinary practice"] } }));
    expect(applyScopePatch(brief, { orgTypes: null })).not.toHaveProperty("scope");
  });

  it("accepts each real option against the brief it was made for, and the result locks", () => {
    for (const option of options()) {
      const result = widenedBrief(C(), option);
      expect(result.ok).toBe(true);
      if (result.ok) expect(lockScope(result.brief).ok).toBe(true);
    }
  });

  it("refuses an option that narrows, touches another dimension, changes nothing, or is not an option at all", () => {
    const narrows = { dimension: "region", text: "Only Kirkwall", scopePatch: { places: [{ name: "Kirkwall" }] } };
    const stray = { dimension: "region", text: "Bigger firms", scopePatch: { size: null } };
    const nothing = { dimension: "region", text: "Great Britain", scopePatch: { countries: ["GB"] } };
    for (const option of [narrows, stray, nothing, { dimension: "pain" }, null]) {
      expect(widenedBrief(C(), option).ok).toBe(false);
    }
    // And a real option over a brief it no longer widens: no places to drop.
    const { scope, ...rest } = C();
    expect(widenedBrief({ ...rest, scope: { countries: scope!.countries } }, options()[0]).ok).toBe(false);
  });

  it("tells briefs apart by what they say, not the order their keys were written in", () => {
    const reorder = (value: unknown): unknown =>
      Array.isArray(value)
        ? value.map(reorder)
        : value !== null && typeof value === "object"
          ? Object.fromEntries(Object.entries(value).reverse().map(([key, inner]) => [key, reorder(inner)]))
          : value;
    const reordered = reorder(C()) as ResearchBrief;
    expect(Object.keys(reordered)).not.toEqual(Object.keys(C()));
    expect(sameBrief(C(), reordered)).toBe(true);
    expect(sameBrief(C(), { ...C(), howMany: 20 })).toBe(false);
  });
});

describe("the widening options on screen", () => {
  it("numbers two options that widen the same thing, and leaves a lone one as it is", () => {
    expect(widenHeadings(["region", "region", "sector"])).toEqual([
      `${campaignsCopy.widenRegion}${campaignsCopy.noteJoin}${campaignsCopy.widenOption} 1`,
      `${campaignsCopy.widenRegion}${campaignsCopy.noteJoin}${campaignsCopy.widenOption} 2`,
      campaignsCopy.widenSector,
    ]);
  });

  it("says what the brief would read after each of brief C's options", () => {
    const lines = stoppedPack().insufficient!.widenings.map((option) => {
      const result = widenedBrief(stoppedBrief() as ResearchBrief, option);
      if (!result.ok) throw new Error(result.issue);
      return becomesLine(option.dimension, briefFieldsFrom(result.brief));
    });
    expect(lines).toEqual([
      `${campaignsCopy.fieldWhere} ${campaignsCopy.widenBecomes} United Kingdom`,
      `${campaignsCopy.fieldWhere} ${campaignsCopy.widenBecomes} United Kingdom, Orkney, Shetland, Western Isles, Highland, Argyll and Bute`,
      `${campaignsCopy.fieldOrgTypes} ${campaignsCopy.widenBecomes} ${campaignsCopy.widenAny}`,
    ]);
  });
});
