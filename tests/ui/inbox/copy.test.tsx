import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  CALL_OUTCOMES,
  FIT_WORDS,
  NEEDS_YOU_REASONS,
  REJECT_REASONS,
  REPLY_LABELS,
  inboxCopy,
} from "@/lib/copy/inbox";
import { assertPlainDashes, assertPlainWords } from "@/lib/copy/plainWords";

/**
 * The Inbox's words: every string passes the rep-words rule, and the three
 * signed vocabularies are the shape Lane A's enums can import.
 *
 * `tests/lib/copy.test.ts` sweeps every copy file already; this repeats the
 * two assertions on this one file by name so a failure here reads as the
 * Inbox's and not as "some copy file", and adds what the sweep cannot know:
 * that the vocabularies are the signed four each, and that each entry has a
 * word on screen.
 */
describe("the Inbox copy", () => {
  it("carries no machine word and no em dash", () => {
    expect(() => assertPlainWords(inboxCopy)).not.toThrow();
    expect(() => assertPlainDashes(inboxCopy)).not.toThrow();
  });

  it("exports the signed reject reasons, labels and outcomes as four each", () => {
    expect(REJECT_REASONS).toEqual(["wrong_angle", "wrong_person", "wrong_fact", "not_now"]);
    expect(REPLY_LABELS).toEqual(["warm", "later", "no", "stop"]);
    expect(CALL_OUTCOMES).toEqual(["spoke", "voicemail", "no_answer", "wrong_number"]);
  });

  it("gives every reason a label and a consequence, and every label and outcome a word", () => {
    for (const reason of REJECT_REASONS) {
      expect(inboxCopy.rejectReason[reason]).toMatch(/\S/);
      expect(inboxCopy.rejectConsequence[reason]).toMatch(/\.$/);
    }
    for (const label of REPLY_LABELS) expect(inboxCopy.replyLabel[label]).toMatch(/\S/);
    for (const outcome of CALL_OUTCOMES) expect(inboxCopy.callOutcome[outcome]).toMatch(/\S/);
    for (const reason of NEEDS_YOU_REASONS) expect(inboxCopy.needsYouReason[reason]).toMatch(/\S/);
    for (const fit of FIT_WORDS) expect(inboxCopy.fit[fit]).toMatch(/\S/);
  });

  /**
   * The four reject consequences are §23.1b's, in rep words: redraft on
   * another pain, close the person's remaining touches, mark the item bad and
   * redraft on the archetype, snooze 14 days. Checked for the one fact a
   * reader would miss, the fortnight.
   */
  it("says the snooze is 14 days", () => {
    expect(inboxCopy.rejectConsequence.not_now).toContain("14 days");
  });

  it("is declared `as const`, so the unions are literal types", () => {
    const source = readFileSync(
      path.join(import.meta.dirname, "..", "..", "..", "src", "lib", "copy", "inbox.ts"),
      "utf8",
    );
    for (const name of ["REJECT_REASONS", "REPLY_LABELS", "CALL_OUTCOMES"]) {
      expect(source, name).toMatch(new RegExp(`export const ${name} = \\[[^\\]]+\\] as const;`));
    }
  });

  /**
   * The words a component assembles at the call site have to come from here
   * too. This reads the Inbox's components for a string literal inside JSX
   * text — the one shape that puts words on a screen without going through
   * the copy file — and expects none.
   */
  it("is the only source of words in the Inbox's components", () => {
    const dir = path.join(import.meta.dirname, "..", "..", "..", "src", "components", "inbox");
    const files = [
      "CallCard.tsx",
      "DraftCard.tsx",
      "EvidenceLine.tsx",
      "Inbox.tsx",
      "LabelRow.tsx",
      "OutcomeRow.tsx",
      "Queue.tsx",
      "QueueRow.tsx",
      "RejectMenu.tsx",
      "ReplyCard.tsx",
      "WhoLine.tsx",
    ];
    for (const file of files) {
      const source = readFileSync(path.join(dir, file), "utf8")
        // Comments say what they like.
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
      // JSX text is anything between `>` and `<` that has a word in it and
      // is not code: a ternary between two elements has letters too.
      const words = (source.match(/>\s*[^<>{}]*[A-Za-z]{3,}[^<>{}]*\s*</g) ?? []).filter(
        (text) => !/[=?():;]/.test(text),
      );
      expect(words, file).toEqual([]);
    }
  });
});
