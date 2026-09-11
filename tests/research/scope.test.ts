import { describe, expect, it } from "vitest";

import {
  lockScope,
  m04ScopeIssues,
  mentions,
  recipeScopeIssues,
  seedFirmKey,
  seedScopeIssues,
  wideningIssue,
  type CompleteModule,
  type LockedScope,
  type Widening,
} from "../../agents/research/output.schema";

/**
 * The rep's locked scope (research v3.2, §10 note 28): what is enforced on
 * m04's seed firms and recipes, what a widening option must do, and — as
 * deterministic claims go — no more than that. Only a field the rep supplied
 * binds; countries always do.
 */

type Seed = CompleteModule<"m04">["perArchetype"][number]["seedFirms"][number];
type Recipe = CompleteModule<"m04">["perArchetype"][number]["recipe"];

const PAGE = "https://register.example/orkney-practices";
const ORKNEY: LockedScope = {
  countries: ["GB"],
  places: [{ name: "Orkney", aliases: ["Orkney Islands", "Kirkwall", "Stromness"] }],
  orgTypes: ["veterinary practice"],
  supplied: ["countries", "places", "orgTypes"],
};
const GB: LockedScope = { countries: ["GB"], supplied: ["countries"] };

const firm = (over: Partial<Seed> = {}): Seed => ({
  id: "firm-1",
  name: "Flett & Carmichael",
  region: "Kirkwall, Orkney Islands",
  country: "GB",
  orgType: "veterinary practice",
  size: { status: "unknown" },
  signal: { id: "firm-1-signal", text: "The practice advertised for a receptionist.", accessedAt: "2026-09-11", evidence: { urls: [PAGE], primary: false, domains: ["register.example"] }, confidence: "weak" },
  ...over,
});
const recipe = (over: Partial<Recipe> = {}): Recipe => ({
  titles: ["Practice manager"],
  excludeTitles: [],
  sizeBand: { min: 5, max: 50 },
  countries: ["GB"],
  industries: ["Veterinary services"],
  triggers: [],
  locations: ["Orkney"],
  ...over,
});
const pages = (text: string) => (url: string) => (url === PAGE ? text : undefined);

describe("lockScope", () => {
  it("takes the fields the rep gave, and the countries from the region when none are given", () => {
    expect(lockScope({ region: "GB" })).toEqual({ ok: true, scope: { countries: ["GB"], supplied: ["countries"] } });
    const locked = lockScope({ region: "GB", scope: { places: [{ name: "Orkney" }], orgTypes: ["veterinary practice"] } });
    expect(locked).toMatchObject({ ok: true, scope: { countries: ["GB"], supplied: ["countries", "places", "orgTypes"] } });
  });

  it("refuses a region outside the scope's countries", () => {
    expect(lockScope({ region: "GB", scope: { countries: ["IE"] } })).toMatchObject({ ok: false, issue: expect.stringMatching(/region GB is not one of scope.countries/) });
  });
});

describe("seed firms against the scope", () => {
  it("passes a firm inside every supplied field, its place on a page it cites", () => {
    expect(seedScopeIssues(firm(), "m04.perArchetype.0.seedFirms.0", ORKNEY, pages("Practices in Kirkwall and Stromness"))).toEqual([]);
  });

  it("refuses a firm whose region names none of the places — brief C's answering bureau in Hampshire", () => {
    const issues = seedScopeIssues(firm({ name: "Frontline Communications", region: "Great Britain (Hampshire 01489)" }), "w", ORKNEY, pages("Orkney"));
    expect(issues).toEqual([expect.stringMatching(/^outside the rep's scope: w \(Frontline Communications\) is in "Great Britain \(Hampshire 01489\)", which names none of the brief's places/)]);
  });

  it("refuses a firm that names the place but cites no page that does — and says the check proves the page, not the address", () => {
    expect(seedScopeIssues(firm(), "w", ORKNEY, pages("A national list of practices."))).toEqual([expect.stringMatching(/cites no page that names Orkney or Orkney Islands or Kirkwall or Stromness/)]);
    // With no pages to read the check cannot be made, and is not.
    expect(seedScopeIssues(firm(), "w", ORKNEY)).toEqual([]);
  });

  it("holds country, org type, exclusions and an employee band only where the rep set them", () => {
    expect(seedScopeIssues(firm({ country: "IE" }), "w", GB).join(" ")).toMatch(/is in IE; the brief is GB/);
    expect(seedScopeIssues(firm({ orgType: undefined }), "w", ORKNEY, pages("Orkney")).join(" ")).toMatch(/needs orgType, one of: veterinary practice/);
    expect(seedScopeIssues(firm({ orgType: "answering bureau" }), "w", ORKNEY, pages("Orkney")).join(" ")).toMatch(/is a "answering bureau"; the brief is veterinary practice/);
    expect(seedScopeIssues(firm({ orgType: "Veterinary Practice" }), "w", ORKNEY, pages("Orkney"))).toEqual([]);
    expect(seedScopeIssues(firm({ orgType: "corporate group" }), "w", { ...GB, excludeOrgTypes: ["corporate group"], supplied: ["countries", "excludeOrgTypes"] }).join(" ")).toMatch(/which the brief excludes/);

    const band: LockedScope = { ...GB, size: { unit: "employees", min: 10, max: 50 }, supplied: ["countries", "size"] };
    expect(seedScopeIssues(firm({ size: { status: "estimated", value: "about 200", employees: { min: 180, max: 220 } } }), "w", band).join(" ")).toMatch(/has 180\+ employees; the brief's band ends at 50/);
    expect(seedScopeIssues(firm({ size: { status: "estimated", value: "a team of 30", employees: { min: 25, max: 35 } } }), "w", band)).toEqual([]);
    expect(seedScopeIssues(firm({ size: { status: "estimated", value: "a team of 30" } }), "w", band).join(" ")).toMatch(/no size.employees/);
    // An unknown size passes; seats are not an employee band and are not checked.
    expect(seedScopeIssues(firm(), "w", band)).toEqual([]);
    expect(seedScopeIssues(firm({ size: { status: "estimated", value: "12 seats" } }), "w", { ...GB, size: { unit: "seats", max: 5 }, supplied: ["countries", "size"] })).toEqual([]);

    const excluded: LockedScope = { ...GB, excludeFirms: [{ name: "Northvet", domain: "https://www.northvet.co.uk/" }], supplied: ["countries", "excludeFirms"] };
    expect(seedScopeIssues(firm({ name: "Northvet Veterinary Group", domain: "northvet.co.uk" }), "w", excluded).join(" ")).toMatch(/a firm the brief excludes/);

    // Countries only: region, org type and size are the model's to judge.
    expect(seedScopeIssues(firm({ region: "Cornwall", orgType: undefined }), "w", GB)).toEqual([]);
  });

  it("knows a firm by its domain, else by its name without punctuation or a legal suffix", () => {
    expect(seedFirmKey({ name: "Northvet", domain: "https://www.Northvet.co.uk/about" })).toBe("domain:northvet.co.uk");
    expect(seedFirmKey({ name: "Flett & Carmichael Ltd" })).toBe(seedFirmKey({ name: "flett and carmichael" }));
  });

  it("matches a place as whole words", () => {
    expect(mentions("Kirkwall, Orkney Islands", "Orkney")).toBe(true);
    expect(mentions("Orkneyshire", "Orkney")).toBe(false);
  });
});

describe("recipes against the scope: they may narrow, never widen", () => {
  it("passes a recipe that keeps the countries, carries the places and stays in the band", () => {
    const band: LockedScope = { ...ORKNEY, size: { unit: "employees", min: 5, max: 50 }, supplied: [...ORKNEY.supplied, "size"] };
    expect(recipeScopeIssues(recipe(), "m04.perArchetype.0", band)).toEqual([]);
  });

  it("refuses wider countries, missing or foreign locations, and a wider band", () => {
    const band: LockedScope = { ...ORKNEY, size: { unit: "employees", min: 5, max: 50 }, supplied: [...ORKNEY.supplied, "size"] };
    const issues = recipeScopeIssues(recipe({ countries: ["GB", "IE"], locations: ["Highlands"], sizeBand: { min: 1, max: 250 } }), "m04.perArchetype.0", band).join(" ");
    expect(issues).toMatch(/adds countries IE/);
    expect(issues).toMatch(/locations names "Highlands", which is not one of the brief's places/);
    expect(issues).toMatch(/sizeBand starts at 1; the brief's band starts at 5/);
    expect(issues).toMatch(/sizeBand ends at 250; the brief's band ends at 50/);
    const { locations: _dropped, ...noLocations } = recipe();
    expect(recipeScopeIssues(noLocations as Recipe, "w", ORKNEY).join(" ")).toMatch(/must carry the brief's places in locations \(Orkney\)/);
  });

  it("refuses an excluded role left out of excludeTitles or put back in titles, and an excluded kind of organisation", () => {
    const scope: LockedScope = { ...GB, roles: { exclude: ["receptionist"] }, excludeOrgTypes: ["corporate group"], supplied: ["countries", "roles", "excludeOrgTypes"] };
    const issues = recipeScopeIssues(recipe({ titles: ["Head receptionist"], locations: undefined, industries: ["Corporate group veterinary"] }), "w", scope).join(" ");
    expect(issues).toMatch(/excludeTitles must exclude "receptionist"/);
    expect(issues).toMatch(/titles include "Head receptionist", an excluded role/);
    expect(issues).toMatch(/industries include "Corporate group veterinary"/);
  });

  it("reads a whole m04: every recipe and every seed firm", () => {
    const m04 = { perArchetype: [{ recipe: recipe(), seedFirms: [firm(), firm({ id: "firm-2", name: "Equicomms", region: "Sussex" })] }] } as unknown as CompleteModule<"m04">;
    const issues = m04ScopeIssues(m04, ORKNEY, pages("Orkney practices"));
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatch(/Equicomms/);
  });
});

describe("widening options: a genuine widening of one dimension the rep set", () => {
  const w = (dimension: Widening["dimension"], scopePatch: Widening["scopePatch"]): Widening => ({ dimension, text: "An option.", scopePatch });

  it("accepts more places, the whole country, more countries, a relaxed band, more org types, fewer exclusions", () => {
    const full: LockedScope = {
      ...ORKNEY,
      size: { unit: "employees", min: 5, max: 50 },
      roles: { exclude: ["receptionist"] },
      supplied: ["countries", "places", "orgTypes", "size", "roles"],
    };
    expect(wideningIssue(full, w("region", { places: [{ name: "Orkney" }, { name: "Shetland" }] }))).toBeNull();
    expect(wideningIssue(full, w("region", { places: null }))).toBeNull();
    expect(wideningIssue(full, w("region", { countries: ["GB", "IE"] }))).toBeNull();
    expect(wideningIssue(full, w("size", { size: { unit: "employees", min: 2, max: 50 } }))).toBeNull();
    expect(wideningIssue(full, w("size", { size: null }))).toBeNull();
    expect(wideningIssue(full, w("sector", { orgTypes: ["veterinary practice", "veterinary answering service"] }))).toBeNull();
    expect(wideningIssue(full, w("role", { roles: { exclude: [] } }))).toBeNull();
  });

  it("refuses an option that narrows, changes nothing, strays into another dimension, or widens what the rep never set", () => {
    expect(wideningIssue(ORKNEY, w("region", { places: [{ name: "Shetland" }] }))).toMatch(/narrows the brief/);
    expect(wideningIssue(ORKNEY, w("region", { places: [{ name: "Orkney" }] }))).toMatch(/does not widen the brief/);
    expect(wideningIssue(ORKNEY, w("region", { orgTypes: ["any"] }))).toMatch(/may change only countries and places/);
    expect(wideningIssue(ORKNEY, w("size", { size: { unit: "employees", max: 500 } }))).toMatch(/the rep set no size to widen/);
    expect(wideningIssue(ORKNEY, w("role", { roles: { include: ["owner"] } }))).toMatch(/the rep set no role to widen/);
    expect(wideningIssue(ORKNEY, w("region", {}))).toMatch(/changes nothing/);
    const band: LockedScope = { ...GB, size: { unit: "employees", min: 5, max: 50 }, supplied: ["countries", "size"] };
    expect(wideningIssue(band, w("size", { size: { unit: "seats", max: 500 } }))).toMatch(/keeps the unit \(employees\)/);
    expect(wideningIssue(band, w("size", { size: { unit: "employees", min: 10, max: 500 } }))).toMatch(/narrows the brief/);
  });
});
