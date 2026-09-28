import { describe, expect, it } from "vitest";

import type { EvidenceQuote } from "../../agents/outreach/input.schema";
import { renderM2Report, repeatedPhrases, sourceReferences } from "@/lib/outreach/cohortReport";
import type { CheckedSequence } from "@/lib/outreach/messageChecks";

/** M2 fix 1: the cohort report's items, counted from stored drafts with no model. */

const fca: EvidenceQuote = {
  id: "fca-root-cause-not-measured",
  quote: "Firms did not always measure the impact of interventions they had made to ensure these were the right changes to make.",
  sourceName: "fca.org.uk",
  url: "https://www.fca.org.uk/publications/good-and-poor-practice/complaints-and-root-cause-analysis",
};
const gives: EvidenceQuote[] = [fca];

const touch = (kind: string, body: string) => ({ kind, body, ask: "", claims: [] });
const sequences: CheckedSequence[] = [
  { name: "Avery Dunmore", touches: [touch("email1", `The FCA's review of 40 firms found this. ${fca.quote} Who looks at the calls behind them?`), touch("li_dm", "The calls behind a complaint are found late at Avery's firm.")] },
  { name: "Emlyn Lomax", touches: [touch("email1", "The FCA says most complaints are upheld. The calls behind a complaint are found late.")] },
];

describe("the cohort report's M2 items", () => {
  it("counts four-word phrases by the people who used them, most first, and leaves out a person's own name", () => {
    const rows = repeatedPhrases(sequences);
    expect(rows).toContainEqual({ phrase: "the calls behind a", people: 2, uses: 2 });
    expect(rows).not.toContainEqual(expect.objectContaining({ phrase: "who looks at the" }));
    expect(rows.every((row) => row.people >= 2)).toBe(true);
    expect(rows.some((row) => row.phrase.includes("avery"))).toBe(false);
  });

  it("lists every source reference with the approved quote the sentence itself carries, and the gate's verdict", () => {
    const refs = sourceReferences(sequences, gives);
    // The framing line carries no quote of its own: its neighbour's does not count (fix round 2).
    expect(refs.filter((row) => row.person === "Avery Dunmore")).toEqual([{ person: "Avery Dunmore", touch: "email1", sentence: "The FCA's review of 40 firms found this.", quotes: [], held: true }]);
    expect(refs.find((row) => row.person === "Emlyn Lomax")).toEqual({ person: "Emlyn Lomax", touch: "email1", sentence: "The FCA says most complaints are upheld.", quotes: [], held: true });
  });

  it("reads the product's name as a name, not a figure", () => {
    const product: CheckedSequence[] = [{ name: "Orla Bellamy", touches: [touch("call", "Insights360 compares each period against the last, so a change is easy to show.")] }];
    expect(sourceReferences(product, gives, ["Insights360"])).toEqual([]);
  });

  it("renders gate hits, holds with reasons and timeouts", () => {
    const markdown = renderM2Report({
      touches: [
        { person: "Avery Dunmore", touch: "email1", state: "failed", findings: [{ rule: "timeout", text: "Writing this ran out of time." }] },
        { person: "Emlyn Lomax", touch: "email1", state: "needs_you", findings: [{ rule: "unsupported-source-claim", text: "Use this approved quote exactly." }] },
        { person: "Emlyn Lomax", touch: "email2", state: "to_review", findings: [] },
      ],
      sequences,
      evidence: gives,
      timeouts: 2,
      modelRuns: 5,
    });
    expect(markdown).toContain("**Model runs that ran out of time:** 2 of 5.");
    expect(markdown).toContain("| timeout | 1 |");
    expect(markdown).toContain("### Held touches, with reasons (2 of 3)");
    expect(markdown).toContain("- **Emlyn Lomax, Email 1** (needs_you): `unsupported-source-claim` Use this approved quote exactly.");
    expect(markdown).not.toMatch(/humaniz/i);
    expect(markdown).toContain("| Emlyn Lomax | Email 1 | The FCA says most complaints are upheld. | **none** | **held** |");
  });
});
