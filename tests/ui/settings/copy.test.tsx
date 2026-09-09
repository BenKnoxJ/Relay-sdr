import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { callsCopy, linkedinCopy, settingsCopy, voiceCopy } from "@/lib/copy/settings";
import { assertPlainDashes, assertPlainWords } from "@/lib/copy/plainWords";

/**
 * The Settings cards' words: every string passes the rep-words rule
 * (§22.4), and the components put no words of their own on the screen.
 *
 * `tests/lib/copy.test.ts` sweeps every copy file already; this repeats the
 * two assertions on the four Settings objects by name so a failure reads as
 * Settings' and not as "some copy file".
 */
describe("the Settings copy", () => {
  it("carries no machine word and no em dash", () => {
    for (const copy of [settingsCopy, linkedinCopy, voiceCopy, callsCopy]) {
      expect(() => assertPlainWords(copy)).not.toThrow();
      expect(() => assertPlainDashes(copy)).not.toThrow();
    }
  });

  it("says the three signed lines in the signed words (§23.1f)", () => {
    expect(linkedinCopy.note).toContain("arrives with Content");
    expect(voiceCopy.promise).toMatch(/^Used as examples in every draft\. Never sent/);
    expect(callsCopy.toggle).toBe("Include a day-3 call in new campaigns by default");
    expect(settingsCopy.saved).toBe("Saved");
  });

  /**
   * The words a component assembles at the call site have to come from the
   * copy file too. This reads the Settings components for a string literal
   * inside JSX text and expects none.
   */
  it("is the only source of words in the Settings components", () => {
    const dir = path.join(import.meta.dirname, "..", "..", "..", "src", "components", "settings");
    for (const file of ["CallsCard.tsx", "LinkedInCard.tsx", "SaveLine.tsx", "VoiceCard.tsx"]) {
      const source = readFileSync(path.join(dir, file), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
      const words = (source.match(/>\s*[^<>{}]*[A-Za-z]{3,}[^<>{}]*\s*</g) ?? []).filter(
        (text) => !/[=?():;]/.test(text),
      );
      expect(words, file).toEqual([]);
    }
  });
});
