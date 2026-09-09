import { TRPCError } from "@trpc/server";
import { z } from "zod";

import { dayNames, mailboxCopy } from "@/lib/copy/settings";
import { assertPlainDashes, assertPlainWords } from "@/lib/copy/plainWords";
import { env } from "@/lib/env";
import {
  CapOutOfRangeError,
  ORG_DEFAULT_DAILY_CAP,
  disconnectMailbox,
  getMailbox,
  setDailyCap,
} from "@/lib/repo/connections";
import { createState } from "@/lib/repo/oauthState";
import { BASE_SCOPES, SEND_SCOPE, authorizeGraphUrl } from "@/lib/services/graphMail";
import { createTRPCRouter, repProcedure } from "@/server/api/trpc";

/**
 * The rep's own connections (master doc §19, §23.1f).
 *
 * The mailbox and nothing else. Zoho is the org's and the admin connects it
 * (slice 3), so there is deliberately no procedure here that could.
 *
 * Every procedure takes the tenant from `ctx` and never from `input` — the
 * lint refuses the other shape — so nothing on this router can be pointed at
 * somebody else's mailbox by a request body.
 */

/** The path Microsoft is told to come back to. One place, two callers. */
export const GRAPH_CALLBACK_PATH = "/api/oauth/graph/callback";

/** The health chip: one word, and the tone the signed palette gives it. */
type Health = { label: string; tone: "ok" | "warn"; note: string | null };

function healthFor(status: "healthy" | "expiring" | "revoked" | "paused"): Health {
  if (status === "expiring") {
    return { label: mailboxCopy.needsRelink, tone: "warn", note: mailboxCopy.needsRelinkWhy };
  }
  if (status === "paused") return { label: mailboxCopy.paused, tone: "warn", note: null };
  return { label: mailboxCopy.healthy, tone: "ok", note: null };
}

export const connectionsRouter = createTRPCRouter({
  /**
   * Everything the Mailbox card renders.
   *
   * The words are assembled here rather than in the component, because the
   * numbers they wrap around live on the row: "of 10 set by your admin" is one
   * sentence, and splitting it across a copy file and a JSX expression is how
   * it ends up reading differently in two places.
   */
  get: repProcedure.query(async ({ ctx }) => {
    const account = await getMailbox(ctx.prisma, { orgId: ctx.orgId, userId: ctx.userId });
    const adminCap = ORG_DEFAULT_DAILY_CAP;

    // `revoked` is not a state the card shows: a disconnected mailbox reads as
    // one that was never connected, plus the Connect button. The row stays
    // because nothing is deleted, but it is not something the rep has.
    if (account === null || account.status === "revoked") {
      const words = { none: mailboxCopy.none, connect: mailboxCopy.connect };
      assertPlainWords(words);
      assertPlainDashes(words);
      return { connected: false as const, adminCap, ...words };
    }

    const user = await ctx.prisma.user.findUnique({
      where: { id: ctx.userId },
      select: { email: true },
    });

    const health = healthFor(account.status);
    const words = {
      provider: mailboxCopy.provider,
      health: health.label,
      healthNote: health.note,
      capNote: `${mailboxCopy.capOf} ${adminCap} ${mailboxCopy.capCeiling}`,
      window: `${account.windowStart} ${mailboxCopy.windowTo} ${account.windowEnd}`,
      days: account.days
        .map((day) => dayNames[day as keyof typeof dayNames])
        .filter((name) => name !== undefined)
        .join(", "),
      ramp: `${mailboxCopy.rampLead} ${account.rampStart} ${mailboxCopy.rampTail}`,
    };

    // The copy this router chose, and not the address: `assertPlainWords` bans
    // thirteen first names among the rest, and a rep called Iris or working out
    // of `vector@` is a real person whose own address must not be refused.
    assertPlainWords(words);
    assertPlainDashes(words);

    return {
      connected: true as const,
      /**
       * The rep's own work address. `ConnectedAccount` has no address column
       * and this task adds no migration, so the card shows the address they
       * signed in with, which in slice 1 is the mailbox they connected: Relay
       * sends as the rep, from the rep's own mailbox. If the two are ever
       * allowed to differ, that is a column and a `/me` read, not a cast.
       */
      address: user?.email ?? null,
      status: account.status,
      healthTone: health.tone,
      cap: account.dailyCap,
      adminCap,
      ...words,
    };
  }),

  /**
   * Start a connect: mint a state, and say where to send the rep.
   *
   * The redirect is built from `APP_URL` and never from the request's own
   * headers. `Host` is client-supplied, so a redirect address derived from it
   * is one an attacker picks — and `redirect_uri` is the field that decides
   * where an authorisation code is delivered.
   */
  startGraphConnect: repProcedure.mutation(async ({ ctx }) => {
    const e = env();
    if (e.APP_URL === undefined) {
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: mailboxCopy.failedSetup });
    }
    if (e.TOKEN_ENC_KEY === undefined) {
      // Nowhere to store what the connect comes back with. Said here, so the
      // rep is not sent to Microsoft to authorise something Relay must then
      // throw away.
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: mailboxCopy.failedSetup });
    }
    if (e.INTEGRATIONS === "live" && (e.RELAY_MS_CLIENT_ID ?? "") === "") {
      // No app registration behind this deployment. Said before the rep is sent
      // to Microsoft, rather than after Microsoft refuses an empty client id.
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: mailboxCopy.failedSetup });
    }

    const state = await createState(ctx.prisma, {
      orgId: ctx.orgId,
      userId: ctx.userId,
      provider: "graph",
    });

    return {
      url: authorizeGraphUrl(e, {
        state,
        redirectUri: new URL(GRAPH_CALLBACK_PATH, e.APP_URL).toString(),
        // Read and send, asked for together. Slice 1 exists to send, so an
        // incremental consent that asked for sending later would put a second
        // Microsoft screen between the rep and their first campaign.
        scope: [...BASE_SCOPES, SEND_SCOPE].join(" "),
      }),
    };
  }),

  /** Stop using this mailbox. Idempotent: disconnecting twice is not an error. */
  disconnectGraph: repProcedure.mutation(async ({ ctx }) => {
    await disconnectMailbox(ctx.prisma, { orgId: ctx.orgId, userId: ctx.userId });
    return { connected: false as const };
  }),

  /**
   * Lower the daily cap. The ceiling is the repository's to enforce; this turns
   * its refusal into a line the card can show.
   */
  setDailyCap: repProcedure
    .input(z.object({ cap: z.number().int() }))
    .mutation(async ({ ctx, input }) => {
      try {
        const account = await setDailyCap(ctx.prisma, {
          orgId: ctx.orgId,
          userId: ctx.userId,
          cap: input.cap,
        });
        if (account === null) {
          throw new TRPCError({ code: "PRECONDITION_FAILED", message: mailboxCopy.none });
        }
        return { cap: account.dailyCap, saved: mailboxCopy.saved };
      } catch (error) {
        if (error instanceof CapOutOfRangeError) {
          throw new TRPCError({ code: "BAD_REQUEST", message: mailboxCopy.capTooHigh });
        }
        throw error;
      }
    }),
});
