import { z } from "zod";

import { campaignsCopy } from "@/lib/copy/campaigns";
import { SENTENCE_MAX } from "@/lib/shell";
import { createTRPCRouter, repProcedure } from "@/server/api/trpc";

/**
 * Campaigns, as far as day one goes.
 *
 * Home's brief box is the only door on day one (master doc §23.1a) and Start
 * is slice 1, so this is the whole of it: take the sentence, keep nothing, and
 * say what happens next.
 *
 * Storing the sentence was considered and rejected. There is no Campaign
 * entity yet, so it could only land somewhere it does not belong, and every
 * write in Relay goes through `src/lib/repo` with an Event beside it (§25,
 * rule 4) — an Event describing a campaign that was not started is a lie in
 * the audit trail. `tests/api/me.test.ts` holds this to writing nothing.
 *
 * It still validates and still requires a session: this is a real endpoint
 * from the moment it ships, and a stub that accepts anything from anyone is a
 * habit that outlives the stub.
 */
export const campaignsRouter = createTRPCRouter({
  stub: repProcedure
    .input(z.object({ sentence: z.string().trim().min(1).max(SENTENCE_MAX) }))
    .mutation(() => ({ line: campaignsCopy.next })),
});
