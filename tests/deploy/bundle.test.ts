import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { prisma } from "@/lib/db";
import { enqueue } from "@/lib/jobs/queue";
import { mutate } from "@/lib/repo/mutate";

import { emptyAll, resetDatabase } from "../db/harness";
import { logLines, spawnBundledWorker } from "../worker/harness";

/**
 * `npm run worker:build` — the artefact systemd runs.
 *
 * Everything else in the suite runs the worker through the tsx loader, which
 * resolves `@/` imports itself and never rewrites a module. The bundle is a
 * different program: esbuild resolves the aliases, splits chunks and decides
 * what stays external. The failures that introduces are all silent at build
 * time and fatal at boot, so the only useful test is the one that runs the
 * built file the way the unit file runs it — `/usr/bin/node dist/worker/main.js`,
 * no loader, nothing on the path but node.
 */

const run = promisify(execFile);
const projectRoot = path.resolve(import.meta.dirname, "..", "..");
const bundle = path.join(projectRoot, "dist", "worker", "main.js");

const ORG_ID = "org_worker_bundle";

beforeAll(async () => {
  await run("npm", ["run", "worker:build"], { cwd: projectRoot });
  await resetDatabase();
}, 180_000);

afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(async () => {
  await emptyAll();
  await mutate(prisma, {
    orgId: ORG_ID,
    actor: { kind: "system" },
    kind: "org.created",
    apply: (tx) => tx.org.create({ data: { id: ORG_ID, name: ORG_ID } }),
  });
});

describe("dist/worker/main.js", () => {
  it("finds the agents/ directory from inside the bundle", async () => {
    // The one thing in the agent runtime that the bundle cannot carry. Every
    // schema is TypeScript and gets bundled; `definition.md`, `prompt.md` and
    // `rubric.md` are markdown read at run time, and `agentsDir()` finds them by
    // walking up from the module to the nearest `package.json` and looking for
    // `agents/` beside it. From `src/lib/agents` that is the repository root;
    // from `dist/worker` it has to be the same answer, and a deploy that ships
    // `dist/` without `agents/` is the failure this catches — at boot, in CI,
    // rather than on the first real run.
    const { job } = await enqueue(prisma, {
      orgId: ORG_ID,
      kind: "echo",
      idempotencyKey: "bundle-echo",
      input: { text: "hello" },
    });

    const worker = spawnBundledWorker(["--once"], {
      NODE_ENV: "test",
      RELAY_AGENT_STUB_MODEL: JSON.stringify({
        calls: [
          { tool: { name: "shout", args: { text: "hello" } }, usage: { in: 100, out: 10 } },
          { text: JSON.stringify({ text: "HELLO" }), usage: { in: 120, out: 12 } },
        ],
      }),
    });
    const finished = await worker.done;

    expect(finished.stderr).toBe("");
    expect(finished.code).toBe(0);

    const after = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(after.status).toBe("done");

    const run = await prisma.agentRun.findFirstOrThrow({ where: { jobId: job.id } });
    expect(run.status).toBe("done");
    expect(run.costTotal.greaterThan(0)).toBe(true);
    // Three steps: two model calls and the tool between them. The prompt that
    // produced them was read off disk by the bundle.
    expect(await prisma.agentRunStep.count({ where: { runId: run.id } })).toBe(3);
  });

  it("claims and completes a job under plain node, with no tsx loader", async () => {
    const { job } = await enqueue(prisma, {
      orgId: ORG_ID,
      kind: "noop",
      idempotencyKey: "bundle-once",
      input: {},
    });

    const worker = spawnBundledWorker(["--once"]);
    const finished = await worker.done;

    expect(finished.stderr).toBe("");
    expect(finished.code).toBe(0);

    const after = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(after.status).toBe("done");

    // The bundle logs the same JSON contract as the source worker: the journal
    // is the only view of a systemd unit, so a bundle that ran but stopped
    // emitting parseable lines would be a live outage with no symptom.
    const started = logLines(finished.stdout).find((line) => line.event === "started");
    expect(started).toMatchObject({ component: "worker", mode: "once", db: "ok" });
  }, 120_000);

  it("keeps the database import dynamic and in its own chunk", async () => {
    // src/worker/main.ts imports `@/lib/db` inside main() on purpose: db.ts
    // reads the environment as it loads, and only there is the throw caught by
    // main().catch. Bundling is what could quietly undo it — esbuild inlines a
    // dynamic import whose target it can resolve, unless the chunk is split
    // out. Proven by sabotage: `splitting: false` in tsup.config.ts fails this.
    //
    // Asserted structurally rather than behaviourally, deliberately. The
    // obvious runtime probe — start the bundle with a broken DATABASE_URL and
    // watch for the JSON failure line — passes whether the import is dynamic
    // or not, because main() calls env() *before* it reaches the import and
    // that is what rejects the bad value. It would have looked like a proof
    // and tested nothing.
    const source = await readFile(bundle, "utf8");
    const dynamicImport = /await import\("(\.\.?\/[^"]+)"\)/.exec(source);

    expect(dynamicImport).not.toBeNull();
    const chunk = path.resolve(path.dirname(bundle), dynamicImport?.[1] ?? "");
    await expect(stat(chunk)).resolves.toBeDefined();
    expect(await readFile(chunk, "utf8")).toMatch(/PrismaClient/);
  }, 60_000);

  it("reports a bad environment as one JSON line on stderr, not a stack trace", async () => {
    // The boot-failure contract, which is all an operator gets: the journal is
    // the only view of a systemd unit, and `systemctl status` shows the last
    // few lines. A raw Node stack trace here is a worker that will not start
    // and will not say why.
    const worker = spawnBundledWorker(["--once"], { DATABASE_URL: "not-a-connection-string" });
    const finished = await worker.done;

    expect(finished.code).toBe(1);
    const reported = JSON.parse(finished.stderr.trim()) as Record<string, unknown>;
    expect(reported).toMatchObject({ component: "worker", event: "failed" });
  }, 120_000);
});
