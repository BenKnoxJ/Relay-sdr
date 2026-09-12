import { TRPCError } from "@trpc/server";

import { authCopy } from "@/lib/copy/auth";
import { hasCampaign } from "@/lib/repo/campaigns";
import { getMailbox, isConnected } from "@/lib/repo/connections";
import { createTRPCRouter, repProcedure } from "@/server/api/trpc";

/**
 * Who is signed in, as the shell needs to render itself.
 *
 * One procedure, because the shell asks one question. The role decides whether
 * the nav carries Admin (master doc §23.0), the name makes the greeting and
 * the avatar's initials, and the two flags decide what Home shows on day one
 * (§23.1a).
 *
 * `hasCampaign` is whether the rep has started a campaign of their own: the
 * nav's "New campaign" and Home's day-one state turn on it.
 *
 * `connections.mailbox` became real in Task 10b. Zoho is org-level and
 * admin-owned, so it stays false until slice 3 gives an admin somewhere to
 * connect it.
 */
export const meRouter = createTRPCRouter({
  get: repProcedure.query(async ({ ctx }) => {
    const user = await ctx.prisma.user.findUnique({
      // `ctx.userId` and nothing off the wire: this is the row the session
      // resolved to (master doc §26).
      where: { id: ctx.userId },
      select: { email: true, name: true, role: true, org: { select: { name: true } } },
    });

    const mailbox = await getMailbox(ctx.prisma, { orgId: ctx.orgId, userId: ctx.userId });

    if (user === null) {
      // `repProcedure` resolved this id from the database moments ago, so the
      // only way here is a row that went away mid-request. Signing in again is
      // the honest instruction, and it is the one the copy file already has.
      throw new TRPCError({ code: "UNAUTHORIZED", message: authCopy.signedOut });
    }

    return {
      email: user.email,
      name: user.name,
      role: user.role,
      orgName: user.org.name,
      hasCampaign: await hasCampaign(ctx.prisma, { orgId: ctx.orgId, userId: ctx.userId }),
      /**
       * A revoked mailbox reads as no mailbox: Home's connect prompt is asking
       * "can Relay send for you yet", and the answer for a disconnected account
       * is no. `expiring` and `paused` are connected — the prompt would be
       * telling the rep to do the wrong thing, and Settings says what is
       * actually wrong.
       */
      connections: { mailbox: isConnected(mailbox), zoho: false },
    };
  }),
});
