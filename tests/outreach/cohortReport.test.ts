import { describe, expect, it } from "vitest";

import type { EvidenceQuote } from "../../agents/outreach/input.schema";
import { renderM2Report, repeatedPhrases, sourceReferences } from "@/lib/outreach/cohortReport";
import type { CheckedSequence } from "@/lib/outreach/messageChecks";
import { loadStandard } from "@/lib/outreach/standard";

/** M2 fix 1: the cohort report's M2 items, counted from stored drafts with no model. */

const gives: EvidenceQuote[] = loadStandard().gives.map(({ scope: _scope, ...quote }) => quote);
const fca = gives.find((give) => give.id === "give-fca-publishes-every-six-months")!;

const touch = (kind: string, body: string) => ({ kind, body, ask: "", claims: [] });
const sequences: CheckedSequence[] = [
  { name: "Avery Dunmore", touches: [touch("email1", `${fca.quote} Who looks at the calls behind them?`), touch("li_dm", "The calls behind a complaint are found late at Avery's firm.")] },
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

  it("lists every source reference with the approved quote it carries, or none", () => {
    const refs = sourceReferences(sequences, gives);
    expect(refs.find((row) => row.person === "Avery Dunmore")).toMatchObject({ touch: "email1", quotes: [fca.id] });
    expect(refs.find((row) => row.person === "Emlyn Lomax")).toEqual({ person: "Emlyn Lomax", touch: "email1", sentence: "The FCA says most complaints are upheld.", quotes: [] });
  });

  it("renders gate hits, holds with reasons, humanizer completion and timeouts", () => {
    const markdown = renderM2Report({
      touches: [
        { person: "Avery Dunmore", touch: "email1", state: "failed", findings: [{ rule: "timeout", text: "Writing this ran out of time." }] },
        { person: "Emlyn Lomax", touch: "email1", state: "needs_you", findings: [{ rule: "unsupported-source-claim", text: "Use this approved quote exactly." }] },
        { person: "Emlyn Lomax", touch: "email2", state: "to_review", findings: [] },
      ],
      humanizer: [
        { person: "Avery Dunmore", ran: false, error: "skipped: nothing written", kept: 0, returned: 0, touches: 7 },
        { person: "Emlyn Lomax", ran: true, kept: 5, returned: 7, touches: 7 },
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
    expect(markdown).toContain("The pass ran for **1 of 2** people.");
    expect(markdown).toContain("| Emlyn Lomax | Email 1 | The FCA says most complaints are upheld. | **none** |");
  });
});
