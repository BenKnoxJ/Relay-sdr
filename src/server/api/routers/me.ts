import { TRPCError } from "@trpc/server";

import { authCopy } from "@/lib/copy/auth";
import { createTRPCRouter, repProcedure } from "@/server/api/trpc";

/**
 * Who is signed in, as the shell needs to render itself.
 *
 * One procedure, because the shell asks one question. The role decides whether
 * the nav carries Admin (master doc §23.0), the name makes the greeting and
 * the avatar's initials, and the two flags decide what Home shows on day one
 * (§23.1a).
 *
 * `hasCampaign` and `connections` are constants today and are here anyway: the
 * first campaign arrives with slice 1 and the mailbox connection with Task
 * 10b. Typing them now means the shell reads one shape before and after, and
 * neither change reaches a component.
 */
export const meRouter = createTRPCRouter({
  get: repProcedure.query(async ({ ctx }) => {
    const user = await ctx.prisma.user.findUnique({
      // `ctx.userId` and nothing off the wire: this is the row the session
      // resolved to (master doc §26).
      where: { id: ctx.userId },
      select: { email: true, name: true, role: true, org: { select: { name: true } } },
    });

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
      /** No Campaign entity until slice 1. Until then nobody has one. */
      hasCampaign: false,
      /** ConnectedAccount is wired up in Task 10b; until then nothing is connected. */
      connections: { mailbox: false, zoho: false },
    };
  }),
});
