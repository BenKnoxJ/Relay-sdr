import { describe, expect, it } from "vitest";

import { industryChoices, translate, type Translation } from "@/lib/leadgen/translate";

import { VOCABULARY, handoff } from "./harness";

/** Provider translation, leadgen v2.1 §5: deterministic, never wider than the signed scope. */

function ok(result: ReturnType<typeof translate>): Translation {
  if (!result.ok) throw new Error(`expected a translation, got ${JSON.stringify(result.halt)}`);
  return result;
}

describe("countries and places", () => {
  it("maps each recipe country to the provider's value, and halts on one it cannot represent", () => {
    expect(ok(translate(handoff(), VOCABULARY)).filters.countries).toEqual(["United Kingdom"]);
    expect(translate(handoff((h) => (h.targeting.countries = ["GB", "US"])), VOCABULARY)).toEqual({
      ok: false,
      halt: { reason: "unmappable", field: "country", term: "US" },
    });
  });

  it("finds a place through the brief's own aliases, at state or city level", () => {
    const result = ok(
      translate(
        handoff((h) => {
          h.targeting.locations = ["Orkney"];
          h.places = [{ name: "Orkney", aliases: ["Orkney Islands"] }];
        }),
        VOCABULARY,
      ),
    );
    expect(result.filters.locations).toEqual([{ value: "Orkney Islands", level: "state", countryIso2: "GB" }]);
    expect(result.effective.locations[0]?.term).toBe("Orkney");
  });

  it("halts rather than drops a place it cannot represent, and never looks outside the recipe's countries", () => {
    expect(translate(handoff((h) => (h.targeting.locations = ["Shetland"])), VOCABULARY)).toEqual({
      ok: false,
      halt: { reason: "unmappable", field: "location", term: "Shetland" },
    });
    // Cork exists, in Ireland; a GB recipe must not reach it.
    expect(translate(handoff((h) => (h.targeting.locations = ["Cork"])), VOCABULARY).ok).toBe(false);
    expect(ok(translate(handoff((h) => {
      h.targeting.countries = ["GB", "IE"];
      h.targeting.locations = ["Cork"];
    }), VOCABULARY)).filters.locations).toEqual([{ value: "Cork", level: "city", countryIso2: "IE" }]);
  });

  it("halts on a name that is two places in one country, rather than guessing", () => {
    expect(translate(handoff((h) => (h.targeting.locations = ["Richmond"])), VOCABULARY)).toEqual({
      ok: false,
      halt: { reason: "unmappable", field: "location", term: "Richmond" },
    });
  });
});

describe("size", () => {
  it("uses only the provider buckets wholly inside the signed band, and records the effective range", () => {
    const result = ok(translate(handoff(), VOCABULARY));
    expect(result.filters.sizes).toEqual([
      { min: 51, max: 200 },
      { min: 201, max: 500 },
    ]);
    expect(result.effective.sizeBand).toEqual({ min: 51, max: 500 });
    for (const size of result.filters.sizes) {
      expect(size.min).toBeGreaterThanOrEqual(50);
      expect(size.max).toBeLessThanOrEqual(500);
    }
  });

  it("halts when no bucket fits inside the band, rather than widening", () => {
    expect(translate(handoff((h) => (h.targeting.sizeBand = { min: 60, max: 150 })), VOCABULARY)).toEqual({
      ok: false,
      halt: { reason: "would_widen", field: "sizeBand" },
    });
  });

  it("passes the band exactly when the provider takes free ranges", () => {
    const result = ok(translate(handoff(), { ...VOCABULARY, sizes: { kind: "range" } }));
    expect(result.filters.sizes).toEqual([{ min: 50, max: 500 }]);
  });
});

describe("industries", () => {
  it("matches a label exactly after normalising, choosing the narrowest level", () => {
    const result = ok(translate(handoff((h) => (h.targeting.industries = ["  INSURANCE "])), VOCABULARY));
    expect(result.filters.industryIds).toEqual(["44"]);
    expect(result.effective.industries).toEqual([{ term: "  INSURANCE ", label: "Insurance", via: "exact" }]);
  });

  it("uses the curated alias table only when it is given one, and resolves the alias by label", () => {
    const research = handoff((h) => (h.targeting.industries = ["General insurance"]));
    expect(translate(research, VOCABULARY).ok).toBe(false);
    const result = ok(translate(research, VOCABULARY, { industryAliases: { "general insurance": "Insurance" } }));
    expect(result.filters.industryIds).toEqual(["44"]);
    expect(result.effective.industries[0]?.via).toBe("alias");
  });

  it("offers up to three plain-words choices from the narrowest level instead of dropping the filter", () => {
    const result = translate(handoff((h) => (h.targeting.industries = ["Specialist insurance"])), VOCABULARY);
    expect(result).toEqual({
      ok: false,
      halt: { reason: "choose_industry", field: "industry", term: "Specialist insurance", choices: ["Insurance", "Insurance Brokers"] },
    });
    // Words only: no provider id is ever offered to a rep.
    if (!result.ok && result.halt.reason === "choose_industry") {
      for (const choice of result.halt.choices) expect(VOCABULARY.industries.some((entry) => entry.id === choice)).toBe(false);
    }
  });

  it("never offers a choice naming a kind of organisation the brief excludes", () => {
    expect(industryChoices("Specialist insurance", VOCABULARY, ["brokers"])).toEqual(["Insurance"]);
  });

  it("resolves a rep's choice only when it was one of the choices offered", () => {
    const research = handoff((h) => (h.targeting.industries = ["Specialist insurance"]));
    const chosen = ok(translate(research, VOCABULARY, { industryChoices: { "specialist insurance": "Insurance Brokers" } }));
    expect(chosen.filters.industryIds).toEqual(["45"]);
    expect(chosen.effective.industries[0]?.via).toBe("choice");
    // "Finance" is a whole sector, never offered, so choosing it does nothing.
    expect(translate(research, VOCABULARY, { industryChoices: { "specialist insurance": "Finance" } }).ok).toBe(false);
  });

  it("halts on a term nothing in the vocabulary resembles", () => {
    expect(translate(handoff((h) => (h.targeting.industries = ["Space tourism"])), VOCABULARY)).toEqual({
      ok: false,
      halt: { reason: "unmappable", field: "industry", term: "Space tourism" },
    });
  });
});

describe("the rest of the recipe", () => {
  it("keeps triggers as context and never sends them as filters", () => {
    const result = ok(translate(handoff(), VOCABULARY));
    expect(result.context.triggers).toEqual(["new claims leadership"]);
    expect(JSON.stringify(result.filters)).not.toContain("new claims leadership");
  });

  it("sends titles, excluded titles and roles, excluded domains and the company limit", () => {
    const result = ok(
      translate(
        handoff((h) => {
          h.exclusions.roles = ["Claims Handler", "Receptionist"];
          h.exclusions.firms = [{ name: "Old Rival", domain: "https://www.oldrival.co.uk/" }, { name: "No Domain Ltd" }];
        }),
        VOCABULARY,
      ),
    );
    expect(result.filters.titles).toEqual(["Head of Claims", "Claims Operations Director"]);
    expect(result.filters.excludeTitles).toEqual(["Claims Handler", "Receptionist"]);
    expect(result.filters.excludeDomains).toEqual(["oldrival.co.uk"]);
    expect(result.filters.maxContactsPerCompany).toBe(3);
    expect(ok(translate(handoff(), { ...VOCABULARY, maxContactsPerCompany: false })).filters.maxContactsPerCompany).toBeUndefined();
  });

  it("is deterministic: the same inputs give the same translation", () => {
    expect(translate(handoff(), VOCABULARY)).toEqual(translate(handoff(), VOCABULARY));
  });
});
