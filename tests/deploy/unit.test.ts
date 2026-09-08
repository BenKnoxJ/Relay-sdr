import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { beforeAll, describe, expect, it } from "vitest";

/**
 * `deploy/relay-worker.service` — the unit file, checked in.
 *
 * A unit file is the one artefact here that nothing else exercises: it is not
 * imported, not built and not run by any test, and its failure mode is a
 * service that will not start on the one machine that matters. So it is linted
 * by systemd itself, and the two numbers that have to agree with each other
 * and with the code are asserted rather than eyeballed.
 */

const run = promisify(execFile);
const unitPath = path.resolve(import.meta.dirname, "..", "..", "deploy", "relay-worker.service");

let unit = "";

beforeAll(async () => {
  unit = await readFile(unitPath, "utf8");
});

/** The value of a `Key=` line in the unit, whitespace trimmed. */
function directive(key: string): string {
  const match = new RegExp(`^${key}=(.*)$`, "m").exec(unit);
  if (match?.[1] === undefined) throw new Error(`the unit has no ${key}= line`);
  return match[1].trim();
}

async function haveSystemdAnalyze(): Promise<boolean> {
  try {
    await run("systemd-analyze", ["--version"]);
    return true;
  } catch {
    return false;
  }
}

describe("deploy/relay-worker.service", () => {
  it("passes systemd's own verifier with no warnings", async () => {
    // Skipped rather than failed where systemd is absent — a container, a Mac
    // — because the unit's correctness is not a property of the machine
    // reading it. The VPS and the CI runner both have it.
    if (!(await haveSystemdAnalyze())) {
      console.log("skipped: systemd-analyze is not installed here");
      return;
    }

    // ExecStart is rewritten to this process's node only because
    // `systemd-analyze verify` checks that the command is executable, and a CI
    // runner's node is not at /usr/bin/node. That the *real* ExecStart names
    // /usr/bin/node — the path that exists on the VPS — is asserted below.
    const dir = await mkdtemp(path.join(tmpdir(), "relay-unit-"));
    const copy = path.join(dir, "relay-worker.service");
    await writeFile(copy, unit.replace(/^ExecStart=\S+/m, `ExecStart=${process.execPath}`));

    const { stderr } = await run("systemd-analyze", ["verify", copy]);

    // `verify` exits 0 on a misspelled directive and only says so on stderr,
    // so the exit code alone would let `Restrt=on-failure` through.
    expect(stderr).toBe("");
  }, 60_000);

  it("execs the built bundle directly, never a wrapper", async () => {
    const tsup = await readFile(
      path.resolve(import.meta.dirname, "..", "..", "tsup.config.ts"),
      "utf8",
    );
    // Task 5 (PR #6): the `tsx` CLI runs the worker in a child process, so
    // systemd's SIGTERM would land on the wrapper and the worker would be
    // SIGKILLed at the stop timeout with a job still leased. The unit must
    // exec the bundle itself.
    expect(directive("ExecStart")).toBe("/usr/bin/node %h/projects/relay/dist/worker/main.js");
    expect(tsup).toMatch(/outDir:\s*"dist"/);
    expect(tsup).toMatch(/"worker\/main":\s*"src\/worker\/main\.ts"/);
    // Comments dropped first: the block above ExecStart explains the tsx
    // finding by name, and matching that would be the test reading its own
    // rationale back as a violation.
    const directives = unit
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("#"))
      .join("\n");
    expect(directives).not.toMatch(/tsx|npm |npx /);
  });

  it("gives the worker's own drain deadline room to finish before systemd kills it", () => {
    // The ordering that matters operationally. The worker's deadline ends in
    // `release`: the job goes back to the queue with its attempt refunded.
    // systemd's deadline is a SIGKILL, which leaves the job on a lease until
    // the reaper takes it. If TimeoutStopSec were the smaller of the two, the
    // good ending would be unreachable.
    const drainMs = Number(/RELAY_WORKER_DRAIN_MS=(\d+)/.exec(unit)?.[1]);
    const stopSec = Number(directive("TimeoutStopSec"));

    expect(Number.isFinite(drainMs)).toBe(true);
    expect(Number.isFinite(stopSec)).toBe(true);
    expect(drainMs).toBeLessThan(stopSec * 1000);
  });

  it("keeps the hardening and restart settings the fleet's other units carry", () => {
    expect(directive("Type")).toBe("simple");
    expect(directive("Restart")).toBe("on-failure");
    expect(directive("KillSignal")).toBe("SIGTERM");
    expect(directive("NoNewPrivileges")).toBe("true");
    expect(directive("PrivateTmp")).toBe("true");
    expect(directive("OnFailure")).toBe("notify-failure@%N.service");
  });
});
