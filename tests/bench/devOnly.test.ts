import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { benchEnabled } from "@/lib/bench/devOnly";
import { parseEnv } from "@/lib/env";

/**
 * The bench does not exist in production, and there are two independent reasons
 * why. Both are checked here, because either one alone is a single point of
 * failure for a page that reads arbitrary files off disk and prints them.
 */

const root = path.resolve(import.meta.dirname, "..", "..");

const BASE = {
  DATABASE_URL: "postgresql://relay:relay@127.0.0.1:5435/relay_test",
  DIRECT_URL: "postgresql://relay:relay@127.0.0.1:5435/relay_test",
};

/** The environment as it would be parsed, without touching this process's own. */
function withNodeEnv(value: string | undefined) {
  return parseEnv(value === undefined ? BASE : { ...BASE, NODE_ENV: value });
}

describe("the bench is development-only", () => {
  /**
   * The suite runs with `NODE_ENV=test`, which is deliberately NOT on the
   * allowlist: the guard is proved by the environment it refuses.
   */
  it("is off in the environment this suite runs in", () => {
    expect(process.env.NODE_ENV).not.toBe("development");
    expect(benchEnabled()).toBe(false);
  });

  it("is off when nothing says otherwise, which is what an ordinary shell looks like", () => {
    expect(benchEnabled(withNodeEnv(undefined))).toBe(false);
  });

  it("is off in production", () => {
    expect(benchEnabled(withNodeEnv("production"))).toBe(false);
  });

  it("is on in development", () => {
    expect(benchEnabled(withNodeEnv("development"))).toBe(true);
  });

  /**
   * The stronger gate: the pages are not compiled as routes at all unless
   * `NODE_ENV` is development. Asserted against the config source rather than
   * against a built app, because building twice to prove it would add minutes
   * to CI for a fact this file states in one line — and `npm run build` in CI
   * already fails if the suffix list is wrong, since the bench pages would then
   * be compiled as routes and their `.dev` siblings collide.
   */
  it("names the bench pages with a suffix a production build does not count", () => {
    const config = readFileSync(path.join(root, "next.config.mjs"), "utf8");
    expect(config).toContain('process.env.NODE_ENV === "development"');
    expect(config).toContain('"dev.tsx"');

    for (const page of [
      "src/app/(bench)/bench/page.dev.tsx",
      "src/app/(bench)/bench/[kind]/[name]/page.dev.tsx",
    ]) {
      const source = readFileSync(path.join(root, page), "utf8");
      // And the run-time gate on top of it, in both pages.
      expect(source, page).toContain("benchEnabled()");
      expect(source, page).toContain("notFound()");
    }
  });
});
