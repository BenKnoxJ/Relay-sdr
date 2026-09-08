import { type ChildProcess, spawn } from "node:child_process";
import path from "node:path";

import { prisma } from "@/lib/db";

/**
 * Running the worker the way it actually runs: as its own operating-system
 * process, with an environment we build rather than inherit.
 *
 * Both of the rubric proofs in this directory are about a process, not a
 * function. Proof 5 asks whether the worker starts on Docker Postgres with no
 * Next or Clerk variables anywhere, and proof 2 asks what survives a SIGKILL —
 * neither question has an answer inside the test runner's own process, where
 * the environment is already the developer's and `process.kill(process.pid)`
 * would take the assertions with it.
 */

const projectRoot = path.resolve(import.meta.dirname, "..", "..");

/**
 * `node --import tsx`, which is what `npm run worker` runs, and not the `tsx`
 * CLI wrapper — measured, not preferred. `tsx src/worker/main.ts` runs the
 * script in a *child* of the tsx process, so a signal sent here lands on the
 * wrapper: SIGKILL orphans a worker that keeps claiming jobs after the test
 * that spawned it has finished (which is how this was found), and SIGTERM ends
 * the wrapper with 143 while the worker is still draining. `--import` loads
 * the loader into this process, so the process the tests signal is the worker.
 */
const nodeArgs = ["--import", "tsx", "src/worker/main.ts"];

/**
 * Everything the worker is allowed to see. Four variables: where Postgres is,
 * twice, and the integration mode. No `NEXT_*`, no `CLERK_*`, no `VERCEL_*`,
 * no `HOME` and no `NODE_ENV` — which also proves the `env()` default holds,
 * since a worker that needed `NODE_ENV` set would not boot here.
 */
export function workerEnv(extra: Record<string, string> = {}): Record<string, string> {
  const url = process.env.DATABASE_URL;
  const direct = process.env.DIRECT_URL ?? url;
  if (url === undefined || direct === undefined) throw new Error("tests: DATABASE_URL is not set");
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    DATABASE_URL: url,
    DIRECT_URL: direct,
    INTEGRATIONS: "mock",
    ...extra,
  };
}

export type WorkerProcess = {
  child: ChildProcess;
  /** Everything written so far, for waiting on a line while the worker runs. */
  output: () => string;
  /** Resolves with the exit code and everything the process wrote. */
  done: Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }>;
};

/** Start a worker. `args` is `["--once"]` or nothing. */
export function spawnWorker(args: string[] = [], extraEnv: Record<string, string> = {}): WorkerProcess {
  const child = spawn(process.execPath, [...nodeArgs, ...args], {
    cwd: projectRoot,
    // Cast because Next augments `NodeJS.ProcessEnv` to require `NODE_ENV`,
    // and the whole point of this environment is that it does not set one:
    // the worker must boot on the `env()` default. The runtime accepts any
    // string map.
    env: workerEnv(extraEnv) as NodeJS.ProcessEnv,
    stdio: ["ignore", "pipe", "pipe"] as const,
  });

  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
  child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString()));

  const done = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
    stdout: string;
    stderr: string;
  }>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code: number | null, signal: NodeJS.Signals | null) =>
      resolve({ code, signal, stdout, stderr }),
    );
  });

  return { child, output: () => stdout, done };
}

/** The JSON lines a finished worker wrote, as objects. */
export function logLines(stdout: string): Array<Record<string, unknown>> {
  return stdout
    .split("\n")
    .filter((line) => line.trim().startsWith("{"))
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/**
 * Wait for something to become true, polling.
 *
 * Never a bare sleep for a state change: "the worker has claimed it by now"
 * is a guess that passes on a fast machine and flakes on a loaded one. The
 * only thing waited on by the clock in these tests is a lease expiring, which
 * is a duration by definition.
 */
export async function waitFor<T>(
  what: string,
  probe: () => Promise<T | null | undefined | false>,
  options: { timeoutMs?: number; everyMs?: number } = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 20_000;
  const everyMs = options.everyMs ?? 50;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== null && value !== undefined && value !== false) return value;
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, everyMs));
  }
}

/** Postgres's own clock, in the same shape the job columns hold. */
export async function databaseNow(): Promise<Date> {
  const rows = await prisma.$queryRaw<Array<{ now: Date }>>`SELECT (now() AT TIME ZONE 'UTC') AS now`;
  const row = rows[0];
  if (row === undefined) throw new Error("tests: the database did not return a time");
  return row.now;
}
