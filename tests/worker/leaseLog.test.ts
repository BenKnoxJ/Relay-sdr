import { describe, expect, it } from "vitest";

import type { Claim } from "@/lib/jobs/queue";
import { withLease } from "@/worker/lease";

/**
 * The one error string in the worker that reaches stdout rather than
 * `Job.error`. It went out raw, which made the scrubber's own module comment
 * ("the second line, for the messages other people's libraries throw") false
 * for the single most likely such message: a Prisma connection failure quotes
 * the connection string, and the connection string carries the password.
 */

const claim: Claim = {
  id: "job_log_scrub",
  orgId: "org_log_scrub",
  kind: "noop",
  attempts: 1,
  workerId: "worker_log_scrub",
} as Claim;

const PASSWORD = ["s3cr3t", "pg", "pw"].join("-");

describe("withLease and the extend-failed log line", () => {
  it("scrubs the credential out of a failed extension's detail", async () => {
    const events: Array<{ event: string; detail?: string }> = [];

    // `$queryRaw` is the only thing `extendLease` touches.
    const db = {
      $queryRaw: () =>
        Promise.reject(
          new Error(
            `Can't reach database server at \`postgresql://relay:${PASSWORD}@10.0.0.4:5432/relay\``,
          ),
        ),
    } as never;

    await withLease(
      db,
      claim,
      async () => {
        // Long enough for one extension tick to fire and fail.
        await new Promise((resolve) => setTimeout(resolve, 60));
        return "done";
      },
      { leaseMs: 5_000, extendEveryMs: 10, log: (event) => events.push(event) },
    );

    const failed = events.filter((e) => e.event === "lease.extend-failed");
    expect(failed.length).toBeGreaterThan(0);
    for (const event of failed) {
      expect(event.detail).not.toContain(PASSWORD);
      expect(event.detail).toContain("[redacted]");
    }
  });
});
