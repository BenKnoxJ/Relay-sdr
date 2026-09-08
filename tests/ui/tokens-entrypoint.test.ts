/**
 * The entry-point guard in `scripts/tokens-css.ts`, on its own.
 *
 * The guard decides whether `main()` — and so the whole `--check` drift
 * comparison — runs at all. Every way it can decline has to be a way it MEANT
 * to decline: a `realpath` that throws is not an answer, and treating it as
 * "not the entry point" leaves `tokens:check` exiting 0 having compared
 * nothing, which is exactly the silent pass the `prebuild` gate exists to
 * stop.
 *
 * Asserted through a real subprocess rather than a module mock, because the
 * thing under test is the exit CODE: `prebuild` reads `$?` and nothing else.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * A driver that imports the generator with `argv[1]` pointing at a path that
 * does not exist, so the guard's first `realpathSync` throws ENOENT. Setting
 * `argv[1]` is how the failure is made deterministic without stubbing `fs`:
 * the guard is reached with a genuinely unresolvable script path, which is the
 * shape of the real fault (a deleted checkout, an unreadable parent, an I/O
 * error on the mount).
 */
function driverThatCannotResolveArgv1(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "relay-tokens-entry-"));
  const script = pathToFileURL(path.join(process.cwd(), "scripts/tokens-css.ts")).href;
  // `.mts`: the temp directory has no `package.json`, so an unsuffixed `.ts`
  // there is transformed as CJS and the top-level `await` below will not compile.
  const driver = path.join(dir, "driver.mts");
  writeFileSync(
    driver,
    `process.argv[1] = ${JSON.stringify(path.join(dir, "gone", "tokens-css.ts"))};\n` +
      `await import(${JSON.stringify(script)});\n`,
  );
  return driver;
}

describe("the tokens generator's entry-point guard", () => {
  it("exits 2 and says why when realpath fails, instead of skipping the check", () => {
    let status: number | undefined;
    let stderr = "";

    try {
      execFileSync("npx", ["tsx", driverThatCannotResolveArgv1(), "--check"], {
        cwd: process.cwd(),
        encoding: "utf8",
      });
    } catch (error) {
      const failure = error as { status?: number; stderr?: string };
      status = failure.status;
      stderr = failure.stderr ?? "";
    }

    // Not 0 (the silent pass) and not 1 (drift found): 2 is "could not tell".
    expect(status).toBe(2);
    expect(stderr).toContain("Could not resolve");
    expect(stderr).toContain("neither checked");
    expect(stderr).toContain("ENOENT");
  }, 60_000);
});
