import { describe, expect, it } from "vitest";

import { AGENT_KINDS, loadDefinition } from "@/lib/agents/definitions";
import { amendedRubric, parseRubric, rubricFor } from "@/lib/bench/rubric";

/**
 * The bench checklist carries lead gen v2.1's rubric, not only v2's table
 * (Critic, PR #28: the parser stopped at the first table). Amended rows
 * replace their v2 row in place; new rows follow.
 */

describe("amendedRubric", () => {
  const markdown = [
    "| # | Check | Pass |",
    "|---|---|---|",
    "| 1 | One | first |",
    "| 2 | Two | second |",
    "",
    "## v9 amendments to this rubric",
    "",
    "Prose between the heading and the table.",
    "",
    "| # | Check | Pass |",
    "|---|---|---|",
    "| 2 | Two | second, amended |",
    "| 3 | Three | third |",
  ].join("\n");

  it("replaces an amended row in place and adds new rows after the rest", () => {
    expect(amendedRubric(markdown)).toEqual([
      { n: "1", check: "One", pass: "first" },
      { n: "2", check: "Two", pass: "second, amended" },
      { n: "3", check: "Three", pass: "third" },
    ]);
  });

  it("is the first table and nothing else when there is no amendment heading", () => {
    expect(amendedRubric(markdown.replace("amendments to this rubric", "notes"))).toEqual(parseRubric(markdown));
  });
});

describe("the lead gen checklist", () => {
  const rows = rubricFor("leadgen");
  const pass = (n: string) => rows.find((row) => row.n === n)?.pass ?? "";

  it("has v2's thirteen rows plus v2.1's nine, numbered once each", () => {
    expect(rows.map((row) => row.n)).toEqual(Array.from({ length: 22 }, (_, index) => String(index + 1)));
  });

  it("carries v2.1's words for the rows it amended", () => {
    expect(pass("2")).toBe("the Confirm-screen cap is shown and the balance snapshot is read server-side before any search");
    expect(pass("5")).toBe("the invariant holds on every request in the mock call log, and unknown outcomes stay reserved");
    expect(pass("9")).toBe("paging stops at `howMany` or at the invariant; partial results are shown as People found X of N");
  });

  it("carries v2.1's new rows, in the words of §14", () => {
    expect(pass("14")).toContain("`LeadGenHandoffV1`");
    expect(pass("15")).toContain("never reads `sourceRank`");
    expect(pass("17")).toContain("zero reveal calls and zero credits");
    expect(pass("22")).toBe("campaign-only holds never write a suppression");
  });

  it("matches the signed definition's §14, word for word", () => {
    const definition = loadDefinition("leadgen").definition;
    for (const n of ["2", "5", "9", "14", "15", "16", "17", "18", "19", "20", "21", "22"]) {
      expect(definition, `row ${n}`).toContain(pass(n));
    }
  });

  it("leaves every other agent's checklist as its first table", () => {
    for (const kind of AGENT_KINDS.filter((kind) => kind !== "leadgen")) {
      expect(rubricFor(kind)).toEqual(parseRubric(loadDefinition(kind).rubric));
    }
  });
});
