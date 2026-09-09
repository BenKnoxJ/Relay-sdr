import { TRPCError } from "@trpc/server";
import { z } from "zod";

import { approvalsCopy } from "@/lib/copy/approvals";
import { assertPlainWords } from "@/lib/copy/plainWords";
import { DraftNotFoundError, approveStubDraft } from "@/lib/repo/approvals";
import { createTRPCRouter, repProcedure } from "@/server/api/trpc";

/**
 * Approving a draft, from a rep's side of the wire.
 *
 * This is the entry point slice 1's Inbox reuses. It is thin on purpose: the
 * transaction, the idempotency and the tenant check all live in
 * `src/lib/repo/approvals.ts`, because a worker and a scheduled approve will
 * need the same thing and a router is not somewhere either can call.
 *
 * What the router owns is the boundary: the session decides the tenant and the
 * approver, the input decides only *which draft*, and the answer is copy.
 */
export const approvalsRouter = createTRPCRouter({
  approveStub: repProcedure
    .input(z.object({ draftEventId: z.string().min(1) }).strict())
    .mutation(async ({ ctx, input }) => {
      let result;
      try {
        result = await approveStubDraft(ctx.prisma, {
          // From the session, both of them. An `orgId` off `input` is a tenant
          // the caller chose for themselves; `eslint.config.mjs` refuses the
          // shape and `tests/lint/tenantId.test.ts` pins the refusal.
          orgId: ctx.orgId,
          userId: ctx.userId,
          draftEventId: input.draftEventId,
        });
      } catch (error) {
        if (error instanceof DraftNotFoundError) {
          // NOT_FOUND for a draft in another tenant as well as for one that
          // does not exist, and deliberately the same answer for both: telling
          // the two apart is how an id becomes an oracle for what other orgs
          // hold. The message is the generic one for the same reason.
          //
          // Swept like the success line below, and not exempted for being an
          // error: a refusal is the one line a rep reads when something has
          // already gone wrong, so it is the worst place for machine words.
          assertPlainWords(approvalsCopy.notFound);
          throw new TRPCError({ code: "NOT_FOUND", message: approvalsCopy.notFound });
        }
        throw error;
      }

      // Three answers, not two. A repeat approve whose send job has spent its
      // attempts is still `alreadyApproved`, but telling that rep "Sending
      // shortly" would be a lie about their own work that no further clicking
      // can correct — `stubSendKey` is derived from the draft, so the spent job
      // is the only job this draft will ever have. Re-running a failed send is
      // a new job with a new key and a decision someone makes on purpose
      // (`queue.ts`, `enqueue`), which is Task 14's to add.
      const line = !result.alreadyApproved
        ? approvalsCopy.approved
        : result.job.status === "failed"
          ? approvalsCopy.sendFailed
          : approvalsCopy.alreadyApproved;

      // The copy this router chose, and not the whole response. `plainWords`
      // says so itself: the check is for rep-facing strings, and sweeping a
      // response that carries ids and a person's own words fails on the data
      // rather than on the copy. (Task 6 review, fix round 1.)
      assertPlainWords(line);

      return { line, alreadyApproved: result.alreadyApproved };
    }),
});
