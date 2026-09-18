import { describe, expect, it } from "vitest";

import { refusalOf } from "@/worker/handlers/outreachDraft";

/** A schema failure as the run reports it: the answer's text, and the issues. */
function refused(answer: { subject?: string; body: string; ask: string }, issues: Array<{ path: string[]; message: string }>) {
  return Object.assign(new Error("schema"), { text: JSON.stringify(answer), issues });
}

describe("refusalOf", () => {
  it("names only the words the prose list refuses", () => {
    const error = refused(
      {
        subject: "Complaints in the pipeline",
        body: "Atlas reviews a few calls a week, so most complaints sit in the pipeline. Our orchestrator reads every call, with no LLM prompt to touch.",
        ask: "Is the current review doing the job?",
      },
      [{ path: ["body"], message: "machine word in a rep-facing string at $: Atlas reviews" }],
    );
    const { fixes, previous } = refusalOf(error);
    expect(fixes).toEqual([`Relay refuses these words in an email, even in their everyday sense: "orchestrator", "llm", "prompt". Say each another way.`]);
    expect(previous?.body).toContain("Our orchestrator reads every call");
  });

  it("names no words when the answer uses only plain English and firm names", () => {
    const error = refused(
      { body: "Vector Capital samples a few calls in its pipeline. Worth a touch base?", ask: "Is the current review doing the job?" },
      [{ path: ["body"], message: "banned dash in a rep-facing string at $: x" }],
    );
    expect(refusalOf(error).fixes).toEqual(["No em dashes, and no en dash with a space beside it."]);
  });
});
