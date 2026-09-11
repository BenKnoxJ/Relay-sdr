import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { prisma } from "@/lib/db";
import { benchFixtureSchema } from "@/lib/bench/fixture";

import { resetDatabase } from "../db/harness";

/**
 * `npm run agent`, end to end, as a process.
 *
 * Spawned rather than imported, because what is being proved is the command: it
 * reads a brief a person wrote, runs the real `runAgent` against the scripted
 * provider, records steps and a cost in the real tables, and leaves a file the
 * bench can read. A test that called an exported function would prove none of
 * the wiring and would not see the exit code, which is the half CI reads.
 *
 * The provider is scripted, so nothing leaves the machine and nothing is spent.
 */

const run = promisify(execFile);
const root = path.resolve(import.meta.dirname, "..", "..");

let out: string;

beforeAll(async () => {
  await resetDatabase();
  out = mkdtempSync(path.join(tmpdir(), "relay-bench-"));
}, 120_000);

afterAll(async () => {
  await prisma.$disconnect();
});

/** The command, with the suite's own database and a scripted provider. */
async function agent(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await run("npx", ["tsx", "scripts/agent.ts", ...args], {
      cwd: root,
      env: {
        ...process.env,
        NODE_ENV: "test",
        INTEGRATIONS: "mock",
      },
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failure.code ?? 1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
  }
}

describe("npm run agent", () => {
  it("runs echo against the recorded provider and writes a fixture that validates", async () => {
    const file = path.join(out, "basic.json");
    const result = await agent([
      "echo",
      "--brief",
      "fixtures/briefs/echo.md",
      "--name",
      "basic",
      "--out",
      file,
    ]);

    expect(result.stderr, result.stderr).toBe("");
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("ok echo/basic");

    const fixture = benchFixtureSchema.parse(JSON.parse(readFileSync(file, "utf8")));
    expect(fixture.source).toBe("run");
    expect(fixture.live).toBe(false);
    expect(fixture.validation).toEqual({ ok: true, errors: [] });
    expect(fixture.output).toEqual({ text: "THE BENCH IS THE SIGN-OFF SURFACE" });
    // Three steps: the call that asked for the tool, the tool, and the answer.
    expect(fixture.run?.steps).toBe(3);
    expect(Number(fixture.run?.cost)).toBeGreaterThan(0);
  }, 120_000);

  it("records the run under the bench org, in the same two tables the worker writes", async () => {
    const org = await prisma.org.findUnique({ where: { id: "org_bench" } });
    expect(org?.name).toBe("bench");

    const runs = await prisma.agentRun.findMany({ where: { orgId: "org_bench", kind: "echo" } });
    expect(runs.length).toBeGreaterThan(0);
    const steps = await prisma.agentRunStep.count({ where: { orgId: "org_bench" } });
    expect(steps).toBeGreaterThan(0);
  });

  it("exits 1 and says what was wrong when the answer does not validate", async () => {
    // A recording whose final answer is the wrong shape: `text` is required and
    // must be a string, so the definition's own schema refuses it.
    const recording = path.join(out, "bad.json");
    writeFileSync(
      recording,
      JSON.stringify({
        model: {
          calls: [{ text: JSON.stringify({ text: 42 }), usage: { in: 100, out: 10 } }],
        },
      }),
    );

    const result = await agent([
      "echo",
      "--brief",
      "fixtures/briefs/echo.md",
      "--name",
      "bad",
      "--recorded",
      recording,
      "--out",
      path.join(out, "bad-fixture.json"),
    ]);

    expect(result.code).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toContain("schema");

    const fixture = benchFixtureSchema.parse(JSON.parse(readFileSync(path.join(out, "bad-fixture.json"), "utf8")));
    expect(fixture.validation.ok).toBe(false);
    expect(fixture.validation.errors.length).toBeGreaterThan(0);
    // The cost is kept: those tokens were spent whether the answer was usable
    // or not, and a bench that hid them would understate what a bad agent costs.
    expect(fixture.run).not.toBeNull();
  }, 120_000);

  it("refuses a brief that is not the definition's input, before anything is spent", async () => {
    const brief = path.join(out, "wrong.md");
    writeFileSync(brief, "# Wrong\n\n```json\n{ \"text\": 42 }\n```\n");

    const before = await prisma.agentRun.count({ where: { orgId: "org_bench" } });
    const result = await agent(["echo", "--brief", brief, "--out", path.join(out, "never.json")]);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("input schema");
    expect(await prisma.agentRun.count({ where: { orgId: "org_bench" } })).toBe(before);
  }, 120_000);

  it("refuses a kind whose tools do not exist in code yet", async () => {
    const result = await agent([
      "research",
      "--brief",
      "fixtures/briefs/research-a-insurance-direct.md",
      "--out",
      path.join(out, "never.json"),
    ]);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("tool set");
  }, 120_000);

  it("refuses a name that is not a fixture name, before anything runs", async () => {
    // The fixture schema would refuse it too, but only after `runAgent` has
    // returned — which on a live run means throwing away paid output.
    const before = await prisma.agentRun.count({ where: { orgId: "org_bench" } });
    const result = await agent([
      "echo",
      "--brief",
      "fixtures/briefs/echo.md",
      "--name",
      "Not A Slug",
      "--out",
      path.join(out, "never.json"),
    ]);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("not a fixture name");
    expect(await prisma.agentRun.count({ where: { orgId: "org_bench" } })).toBe(before);
  }, 120_000);

  it("refuses to spend on a live run without --yes", async () => {
    const result = await agent([
      "echo",
      "--brief",
      "fixtures/briefs/echo.md",
      "--live",
      "--out",
      path.join(out, "never.json"),
    ]);

    expect(result.code).toBe(1);
    // Either there is no credential at all, or there is one and the estimate
    // was printed and the run refused. Both are a refusal to spend silently.
    expect(`${result.stdout}${result.stderr}`).toMatch(/--yes|needs a credential/);
  }, 120_000);
});
