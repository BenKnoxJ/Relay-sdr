/// <reference types="vite/client" />
import { describe, it, expect } from "vitest";

import {
  MACHINE_WORDS,
  BANNED_DASHES,
  readableStrings,
} from "@/lib/copy/plainWords";

/**
 * Every rep-facing string lives in `src/lib/copy/*`, and none of them may carry
 * a machine word (master doc §22.4).
 *
 * The glob is eager and untyped on purpose: a new copy file is covered the
 * moment it lands, without anyone remembering to list it here. It recurses, so
 * a future `copy/screens/callCard.ts` is covered too.
 */
const all = import.meta.glob("../../src/lib/copy/**/*.ts", { eager: true }) as Record<
  string,
  Record<string, unknown>
>;

/** `plainWords.ts` is the rule itself, not copy: it exports no on-screen string. */
const modules = Object.fromEntries(
  Object.entries(all).filter(([file]) => !file.endsWith("/plainWords.ts")),
);

/** Every string a copy module exports, as `file export.path: text`. */
function everyString(): [string, string][] {
  const out: [string, string][] = [];
  for (const [file, module] of Object.entries(modules)) {
    for (const [name, exported] of Object.entries(module)) {
      for (const [path, text] of readableStrings(exported, name)) out.push([`${file} ${path}`, text]);
    }
  }
  return out;
}

describe("src/lib/copy", () => {
  it("has copy files to check", () => {
    expect(Object.keys(modules).length).toBeGreaterThanOrEqual(1);
  });

  it("every copy file exports at least one string", () => {
    for (const [file, module] of Object.entries(modules)) {
      const found = Object.entries(module).flatMap(([name, exported]) =>
        readableStrings(exported, name),
      );
      expect(found.length, file).toBeGreaterThan(0);
    }
  });

  it("carries no machine word in any exported string", () => {
    const offenders = everyString()
      .filter(([, text]) => MACHINE_WORDS.test(text))
      .map(([where, text]) => `${where}: ${text}`);
    expect(offenders).toEqual([]);
  });

  it("carries no em dash, and no en dash used as punctuation", () => {
    const offenders = everyString()
      .filter(([, text]) => BANNED_DASHES.test(text))
      .map(([where, text]) => `${where}: ${text}`);
    expect(offenders).toEqual([]);
  });
});
