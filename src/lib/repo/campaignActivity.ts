import type { Prisma, PrismaClient } from "@prisma/client";

import { ACTIVITY_KINDS, type ActivityRow } from "@/lib/campaigns/activity";

type Db = PrismaClient | Prisma.TransactionClient;

/** How many entries one read returns at most. */
export const ACTIVITY_LIMIT = 50;

/**
 * One campaign's activity, newest first, for its owner only (null otherwise):
 * one query on `(campaign_id, at)`, each Event reduced in SQL to the few
 * fields its line needs, with the actor's name. No pack, handoff or
 * candidate list leaves the database.
 */
export async function campaignActivityFor(db: Db, scope: { orgId: string; userId: string; campaignId: string; limit?: number }): Promise<ActivityRow[] | null> {
  const campaign = await db.campaign.findFirst({ where: { id: scope.campaignId, orgId: scope.orgId, ownerUserId: scope.userId }, select: { id: true } });
  if (campaign === null) return null;
  const limit = Math.min(Math.max(Math.trunc(scope.limit ?? 30), 1), ACTIVITY_LIMIT);
  return db.$queryRaw<ActivityRow[]>`
    SELECT e.id,
           e.kind,
           e.at,
           e.actor_kind::text AS "actorKind",
           e.actor_user_id AS "actorUserId",
           u.name AS "actorName",
           -- One branch per kind in ACTIVITY_KINDS (src/lib/campaigns/activity.ts) whose line needs fields;
           -- keep the two in step. Kinds whose line is fixed words have no branch.
           CASE e.kind
             WHEN 'campaign.brief_changed' THEN jsonb_build_object('cause', e.after->'cause', 'briefVersion', e.after->'briefVersion')
             WHEN 'research.completed' THEN jsonb_build_object('outcome', e.after->'outcome')
             WHEN 'campaign.confirmed' THEN jsonb_build_object('group', e.after->'handoff'->'buyerGroup'->'name', 'selection', e.after->'selection')
             WHEN 'leadgen.picked' THEN jsonb_build_object('found', e.after->'output'->'found'->'n', 'of', e.after->'output'->'found'->'ofM')
             WHEN 'leadgen.rerun' THEN jsonb_build_object('cause', e.after->'cause', 'choice', e.after->'choice'->'label')
             WHEN 'campaign.people_reviewed' THEN jsonb_build_object(
               'decision', e.after->'decision',
               'scope', e.after->'scope',
               'people', CASE WHEN jsonb_typeof(e.after->'people') = 'array' THEN jsonb_array_length(e.after->'people') ELSE 0 END
             )
             WHEN 'campaign.reveal_confirmed' THEN jsonb_build_object('toReveal', e.after->'counts'->'toReveal', 'known', e.after->'counts'->'known', 'maxCredits', e.after->'maxCredits')
             WHEN 'leadgen.revealed' THEN jsonb_build_object('revealed', e.after->'tally'->'revealed', 'known', e.after->'tally'->'known', 'charged', e.after->'spend'->'charged')
           END AS projection
      FROM events e
      LEFT JOIN users u ON u.id = e.actor_user_id AND u.org_id = e.org_id
     WHERE e.org_id = ${scope.orgId}
       AND e.campaign_id = ${scope.campaignId}
       AND e.kind = ANY(${[...ACTIVITY_KINDS]}::text[])
     ORDER BY e.at DESC, e.id DESC
     LIMIT ${limit}
  `;
}
