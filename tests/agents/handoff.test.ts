import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { approvalsCopy } from "@/lib/copy/approvals";
import { prisma } from "@/lib/db";
import { enqueue } from "@/lib/jobs/queue";
import {
  DRAFT_APPROVED,
  DRAFT_READY,
  DraftNotFoundError,
  SEND_RECORDED,
  approveStubDraft,
  stubSendKey,
} from "@/lib/repo/approvals";
import { appRouter } from "@/server/api/root";
import { type TRPCContext } from "@/server/api/trpc";
import { type Session } from "@/server/auth/session";
import { ensureUser, type Actor } from "@/server/auth/upsertUser";

import { emptyAll, resetDatabase } from "../db/harness";
import { spawnWorker } from "../worker/harness";

/**
 * Proof 3: the approval hand-off, with no in-memory state.
 *
 * The rubric's pass condition is a sentence about processes: "`stub_draft` ends
 * its run at `drafts_ready` with an Event; worker process exited; `approve`
 * writes an Event and enqueues `stub_send` in one transaction; a new worker
 * process completes `stub_send`", with the tolerance "two distinct OS
 * processes. Nothing read from memory, files or env between them; only the
 * database."
 *
 * So the test spawns two workers and asserts they are two — different pids, the
 * first already exited before the approve is issued. That is not decoration: a
 * single long-lived worker would pass every database assertion below while
 * still holding the draft in a closure, which is precisely the design §24
 * rejects. The processes are the proof; the rows are what they prove about.
 *
 * The environment carries nothing between the two spawns either. `workerEnv`
 * builds each child's environment from scratch — Postgres, the integration mode
 * and the scripted model, and that last one is the same fixed script both times
 * rather than anything derived from the first run.
 */

/** Clerk's server module will not load outside an RSC. Same seam as `me.test.ts`. */
vi.mock("@clerk/nextjs/server", () => ({
  auth: async () => ({ userId: null }),
  currentUser: async () => null,
}));

/** One model call, answering with the draft. `stub_draft` needs no tool call. */
const SCRIPT = JSON.stringify({
  calls: [{ text: JSON.stringify({ text: "HELLO" }), usage: { in: 2_000, out: 40 } }],
});

/** sha256("HELLO"), which is what `stub_send` should record. */
const HELLO_SHA256 = "3733cd977ff8eb18b987357e22ced99f46097f31ecb239e878ae63760e83e4d5";

function contextFor(session: Session): TRPCContext {
  let pending: Promise<Actor> | undefined;
  return {
    prisma,
    headers: new Headers(),
    session,
    actor: () => (pending ??= ensureUser(prisma, session)),
  };
}

const repSession: Session = {
  clerkId: "user_rep",
  profile: async () => ({ email: "rep@example.test", name: "A Rep" }),
};

beforeAll(async () => {
  await resetDatabase();
}, 120_000);

afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(async () => {
  await emptyAll();
});

/**
 * Sign the rep in, which is what creates their org and their user row (Task 8).
 * The org is derived from the email domain, so it is read back rather than
 * chosen here.
 */
async function signIn(): Promise<Actor> {
  return ensureUser(prisma, repSession);
}

/** Run one job to completion in its own worker process. Returns that process's pid. */
async function runOneJob(): Promise<number> {
  const worker = spawnWorker(["--once"], { NODE_ENV: "test", RELAY_AGENT_STUB_MODEL: SCRIPT });
  const pid = worker.child.pid;
  if (pid === undefined) throw new Error("the worker did not start");
  const finished = await worker.done;
  expect(finished.stderr).toBe("");
  expect(finished.code).toBe(0);
  return pid;
}

describe("the approval hand-off", () => {
  it("@proof drafts in one process, approves in the database, sends in another", async () => {
    const actor = await signIn();

    const { job: draftJob } = await enqueue(prisma, {
      orgId: actor.orgId,
      ownerUserId: actor.userId,
      kind: "stub_draft",
      idempotencyKey: "campaignless:stub_draft:proof-3",
      input: { text: "hello" },
    });

    // ---- The first run: draft, and stop. -----------------------------------
    const firstPid = await runOneJob();

    const drafted = await prisma.job.findUniqueOrThrow({ where: { id: draftJob.id } });
    expect(drafted.status).toBe("done");
    expect(drafted.attempts).toBe(1);

    // The run ended. `drafts_ready` is the phase, `done` is the run's status —
    // there is no suspended run anywhere, which is the claim.
    const run = await prisma.agentRun.findFirstOrThrow({ where: { jobId: draftJob.id } });
    expect(run.status).toBe("done");
    expect(run.finishedAt).not.toBeNull();

    const draft = await prisma.event.findFirstOrThrow({
      where: { orgId: actor.orgId, kind: DRAFT_READY },
    });
    expect(draft.actorKind).toBe("system");
    expect(draft.after).toMatchObject({ jobId: draftJob.id, runId: run.id, text: "HELLO" });

    // Nothing has been enqueued for the send half yet: approving is a separate
    // act, and until a rep does it there is no work waiting anywhere.
    expect(await prisma.job.count({ where: { kind: "stub_send" } })).toBe(0);

    // ---- The worker that drafted is gone. ----------------------------------
    // `runOneJob` awaited the child's `close`, so the process has exited. The
    // assertion is worth making explicitly rather than leaving implicit in the
    // await: everything below runs with no worker alive at all.
    expect(isAlive(firstPid)).toBe(false);

    // ---- The approve: an Event and a job, in one transaction. --------------
    const approved = await approveStubDraft(prisma, {
      orgId: actor.orgId,
      userId: actor.userId,
      draftEventId: draft.id,
    });
    expect(approved.alreadyApproved).toBe(false);
    expect(approved.job.kind).toBe("stub_send");
    expect(approved.job.idempotencyKey).toBe(stubSendKey(draft.id));
    expect(approved.job.status).toBe("queued");
    expect(approved.job.input).toMatchObject({ draftEventId: draft.id });

    const approval = await prisma.event.findFirstOrThrow({
      where: { orgId: actor.orgId, kind: DRAFT_APPROVED },
    });
    // A user approved, and the Event names them. That is the point of it.
    expect(approval.actorKind).toBe("user");
    expect(approval.actorUserId).toBe(actor.userId);
    expect(approval.after).toMatchObject({ draftEventId: draft.id });

    // ---- Approving again: same job, no second Event. -----------------------
    const again = await approveStubDraft(prisma, {
      orgId: actor.orgId,
      userId: actor.userId,
      draftEventId: draft.id,
    });
    expect(again.alreadyApproved).toBe(true);
    expect(again.job.id).toBe(approved.job.id);
    expect(await prisma.event.count({ where: { kind: DRAFT_APPROVED } })).toBe(1);
    expect(await prisma.job.count({ where: { kind: "stub_send" } })).toBe(1);

    // ---- The second run: a different process entirely. ---------------------
    const secondPid = await runOneJob();
    // Two distinct OS processes, which is the rubric's tolerance stated as an
    // assertion. Nothing could have been carried in memory between them because
    // there was no shared memory to carry it in.
    expect(secondPid).not.toBe(firstPid);

    const sent = await prisma.job.findUniqueOrThrow({ where: { id: approved.job.id } });
    expect(sent.status).toBe("done");
    expect(sent.attempts).toBe(1);
    expect(sent.responseDigest).toMatch(/^[0-9a-f]{64}$/);

    const record = await prisma.event.findFirstOrThrow({
      where: { orgId: actor.orgId, kind: SEND_RECORDED },
    });
    expect(record.actorKind).toBe("system");
    expect(record.after).toMatchObject({
      jobId: approved.job.id,
      draftEventId: draft.id,
      // The digest of the text the *first* process drafted, computed by the
      // second. It could only have come from the database.
      digest: HELLO_SHA256,
    });

    // The whole hand-off, in order, as three rows and nothing else.
    const timeline = await prisma.event.findMany({
      where: { orgId: actor.orgId, kind: { in: [DRAFT_READY, DRAFT_APPROVED, SEND_RECORDED] } },
      orderBy: { at: "asc" },
    });
    expect(timeline.map((event) => event.kind)).toEqual([
      DRAFT_READY,
      DRAFT_APPROVED,
      SEND_RECORDED,
    ]);
  }, 120_000);

  it("@proof approves through the router, on the session's org and user", async () => {
    const actor = await signIn();

    await enqueue(prisma, {
      orgId: actor.orgId,
      ownerUserId: actor.userId,
      kind: "stub_draft",
      idempotencyKey: "campaignless:stub_draft:through-the-router",
      input: { text: "hello" },
    });
    await runOneJob();

    const draft = await prisma.event.findFirstOrThrow({
      where: { orgId: actor.orgId, kind: DRAFT_READY },
    });

    const caller = appRouter.createCaller(contextFor(repSession));
    const first = await caller.approvals.approveStub({ draftEventId: draft.id });
    expect(first).toEqual({ line: approvalsCopy.approved, alreadyApproved: false });

    // The same request again, which is a double-click or a retried mutation.
    const second = await caller.approvals.approveStub({ draftEventId: draft.id });
    expect(second).toEqual({ line: approvalsCopy.alreadyApproved, alreadyApproved: true });

    const job = await prisma.job.findUniqueOrThrow({
      where: {
        orgId_idempotencyKey: { orgId: actor.orgId, idempotencyKey: stubSendKey(draft.id) },
      },
    });
    // Owned by the rep who approved, taken from the session and not from input.
    expect(job.ownerUserId).toBe(actor.userId);
    expect(await prisma.event.count({ where: { kind: DRAFT_APPROVED } })).toBe(1);
  }, 120_000);

  it("refuses a draft belonging to another company", async () => {
    const actor = await signIn();

    await enqueue(prisma, {
      orgId: actor.orgId,
      ownerUserId: actor.userId,
      kind: "stub_draft",
      idempotencyKey: "campaignless:stub_draft:other-tenant",
      input: { text: "hello" },
    });
    await runOneJob();

    const draft = await prisma.event.findFirstOrThrow({
      where: { orgId: actor.orgId, kind: DRAFT_READY },
    });

    // Someone else's session, pointed at this org's draft id.
    const outsider = await ensureUser(prisma, {
      clerkId: "user_outsider",
      profile: async () => ({ email: "someone@other.test", name: "Outsider" }),
    });
    expect(outsider.orgId).not.toBe(actor.orgId);

    await expect(
      approveStubDraft(prisma, {
        orgId: outsider.orgId,
        userId: outsider.userId,
        draftEventId: draft.id,
      }),
    ).rejects.toBeInstanceOf(DraftNotFoundError);

    // Refused before anything was written: no Event, and no job to send with.
    expect(await prisma.event.count({ where: { kind: DRAFT_APPROVED } })).toBe(0);
    expect(await prisma.job.count({ where: { kind: "stub_send" } })).toBe(0);
  }, 120_000);

  it("writes one Event and one job when two approvals race", async () => {
    const actor = await signIn();

    await enqueue(prisma, {
      orgId: actor.orgId,
      ownerUserId: actor.userId,
      kind: "stub_draft",
      idempotencyKey: "campaignless:stub_draft:racing",
      input: { text: "hello" },
    });
    await runOneJob();

    const draft = await prisma.event.findFirstOrThrow({
      where: { orgId: actor.orgId, kind: DRAFT_READY },
    });

    // Issued together rather than one after the other. The sequential repeat is
    // covered by the router test above; what this adds is that the answer does
    // not depend on the two transactions being tidily ordered.
    const results = await Promise.all([
      approveStubDraft(prisma, {
        orgId: actor.orgId,
        userId: actor.userId,
        draftEventId: draft.id,
      }),
      approveStubDraft(prisma, {
        orgId: actor.orgId,
        userId: actor.userId,
        draftEventId: draft.id,
      }),
    ]);

    expect(results.map((result) => result.job.id)).toEqual([
      results[0]?.job.id,
      results[0]?.job.id,
    ]);
    expect(results.filter((result) => !result.alreadyApproved)).toHaveLength(1);
    expect(await prisma.event.count({ where: { kind: DRAFT_APPROVED } })).toBe(1);
    expect(await prisma.job.count({ where: { kind: "stub_send" } })).toBe(1);
  }, 120_000);
});

/** Whether a pid is still a live process. Signal 0 tests, it does not deliver. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
