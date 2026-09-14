import { describe, expect, it } from "vitest";

import { matchRole, rolePieces, roleTable, titlesByPart } from "@/lib/leadgen/roles";

import { MOTOR_ROLES, MOTOR_TITLES } from "./harness";

/**
 * Role matching, leadgen v2.2 §8a: per confirmed group, from Research's own
 * compound titles, exact before phrase, never a single word, never a guess.
 */

const motor = roleTable(MOTOR_ROLES);

describe("rolePieces", () => {
  it("splits Research's compound titles on its own / and or, and normalises each piece", () => {
    expect(rolePieces("Head of Claims / Claims Operations Manager")).toEqual(["head of claims", "claims operations manager"]);
    expect(rolePieces("Claims Quality / QA Manager or Analyst")).toEqual(["claims quality", "qa manager", "analyst"]);
    expect(rolePieces("Claims Director or Chief Operating Officer")).toEqual(["claims director", "chief operating officer"]);
  });
});

describe("matchRole", () => {
  it("matches an exact normalised title first", () => {
    expect(matchRole("Chief Operating Officer", motor)).toEqual({ part: "signs", title: "Claims Director or Chief Operating Officer", how: "exact" });
    expect(matchRole("head of claims", motor)).toMatchObject({ part: "runs", how: "exact" });
    expect(matchRole("Complaints Manager", motor)).toMatchObject({ part: "champions", how: "exact", title: "Customer Relations / Complaints Manager" });
  });

  it("matches a meaningful multi-word piece as a whole phrase", () => {
    expect(matchRole("Claims Quality Manager", motor)).toMatchObject({ part: "champions", how: "phrase" });
    expect(matchRole("Head of Customer Relations", motor)).toMatchObject({ part: "champions", how: "phrase" });
    expect(matchRole("Deputy Head of Claims", motor)).toMatchObject({ part: "runs", how: "phrase" });
  });

  it("never phrase-matches a single or generic word, and never a part of a word", () => {
    // "analyst" is a piece of the champions role, but one word never matches by containment.
    expect(matchRole("Senior Data Analyst", motor)).toBeNull();
    expect(matchRole("Operations Manager", motor)).toBeNull();
    // Whole words only: "claims directorate lead" does not contain "claims director".
    expect(matchRole("Claims Directorate Lead", motor)).toBeNull();
  });

  it("is a Related role, not a guess, when nothing matches or matches disagree on the part", () => {
    expect(matchRole("Head of Motor Claims", motor)).toBeNull();
    expect(matchRole("Claims Operations Director", motor)).toBeNull();
    // Contains a runs piece and a signs piece: two parts, so no match.
    expect(matchRole("Head of Claims and Claims Director", motor)).toBeNull();
  });

  it("is per group: the same title plays different parts in different groups", () => {
    const delegated = roleTable([
      { title: "Head of Claims Operations / Operations Director", seniority: "Senior", part: "runs", needs: "x" },
      { title: "Managing Director", seniority: "Executive", part: "signs", needs: "y" },
    ]);
    const home = roleTable([
      { title: "Head of Claims", seniority: "Senior", part: "runs", needs: "x" },
      { title: "Claims Director / Operations Director", seniority: "Executive", part: "signs", needs: "y" },
    ]);
    expect(matchRole("Operations Director", delegated)?.part).toBe("runs");
    expect(matchRole("Operations Director", home)?.part).toBe("signs");
  });

  it("never reads seniority: a C-suite title that names no role is still a Related role", () => {
    expect(matchRole("Chief Executive Officer", motor)).toBeNull();
  });
});

describe("titlesByPart", () => {
  it("partitions the recipe by role, and leaves titles that match none out", () => {
    expect(titlesByPart(MOTOR_TITLES, motor)).toEqual({
      runs: ["Head of Claims", "Claims Operations Manager"],
      champions: ["Claims Quality Manager", "Head of Customer Relations", "Complaints Manager"],
      signs: ["Claims Director", "Chief Operating Officer"],
    });
  });
});
