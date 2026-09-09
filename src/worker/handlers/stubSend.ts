import { createHash } from "node:crypto";

import { z } from "zod";

import { DRAFT_READY, draftText, recordStubSend } from "@/lib/repo/approvals";
import { TerminalError } from "@/worker/errors";
import type { Handler } from "@/worker/handlers/index";

/**
 * The second half of the approval hand-off: act on a draft a rep approved.
 *
 * The job that runs this was enqueued by `approveStubDraft`, in the same
 * transaction as the `draft.approved` Event. Everything it needs is in its own
 * `input` and in the database — which is the claim proof 3 exists to test,
 * because this handler runs in a process that was not alive when the draft was
 * made and cannot read anything the drafting process held.
 *
 * It sends nothing. A sha256 of the drafted text stands in for the send, so the
 * proof is about the hand-off and not about a mail provider: adding a real call
 * here would put a second thing that can fail inside the one thing being
 * proved. Task 14 replaces the digest with a Graph send through the outbox, and
 * the shape either side of it does not move.
 *
 * There is deliberately no `SideEffect` row. That is §25 rule 2's record of
 * something the world can see, and nothing here is visible to anyone: writing
 * one would claim an external effect that did not happen, in the exact table a
 * real send's retry consults to decide whether to send. Task 14 adds it with
 * the send it belongs to.
 */

const inputSchema = z.object({ draftEventId: z.string().min(1) }).strict();

export const stubSend: Handler = async ({ db, job }) => {
  const parsed = inputSchema.safeParse(job.input);
  if (!parsed.success) {
    throw new TerminalError(
      `stub_send: bad input (${parsed.error.issues.map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`).join("; ")})`,
    );
  }

  // The org is the job's, which came from the session that approved. The draft
  // has to be in it: without this the id in `input` would be enough to act on
  // another tenant's draft, and a job's input is not a thing anyone should have
  // to trust. §25 rule 3, and the same check `approveStubDraft` makes — made
  // again here because this runs in a different process, from a row, long after
  // the request that wrote it.
  const draft = await db.event.findFirst({
    where: { id: parsed.data.draftEventId, orgId: job.orgId, kind: DRAFT_READY },
  });
  if (draft === null) {
    // Terminal: the draft is not going to appear in this org later. Names the
    // id the job already carried and nothing about what else exists.
    throw new TerminalError(
      `stub_send: no draft ready under ${JSON.stringify(parsed.data.draftEventId)}`,
    );
  }

  const text = draftText(draft.after);
  if (text === null) {
    throw new TerminalError(`stub_send: the draft ${JSON.stringify(draft.id)} carries no text`);
  }

  const digest = createHash("sha256").update(text, "utf8").digest("hex");

  await recordStubSend(db, {
    orgId: job.orgId,
    jobId: job.id,
    draftEventId: draft.id,
    digest,
  });

  // The digest, and only the digest — not the text, which is a rep's own words
  // and has no business in a job row. `Job.responseDigest` is hashed over this,
  // so two attempts of the same send agree, as they should.
  return { digest };
};
