import type { Prisma, PrismaClient } from "@prisma/client";

import { START_HORIZON_DAYS, addCalendarDays, fromDbDate, isIsoDate, londonDay, startDayFor, toDbDate, type IsoDate } from "@/lib/outreach/sequence";

import { mutate } from "./mutate";

/**
 * Start outreach, and Pause and Resume a campaign (Relay P3).
 *
 * Start outreach gives every kept, revealed person who has drafts and no start
 * day yet the day the rep chose. A person's day is set once: a later batch
 * (P5b) is started by the same press and keeps nobody else's day. Pause sets
 * `campaigns.outreach_paused_at` and Resume clears it; while it is set nothing
 * is due (P5, P6) and nothing is sent (P7). No scheduler and no job: a step's
 * due day is worked out when it is read (`src/lib/outreach/sequence.ts`).
 *
 * Each write is one `mutate`, with its Event, under a lock on the rep's own
 * campaign, so two presses cannot both start the same people. The org and the
 * rep come from the session; a campaign that is not theirs is `not_found`.
 */

export const OUTREACH_STARTED = "outreach.started" as const;
export const OUTREACH_PAUSED = "outreach.paused" as const;
export const OUTREACH_RESUMED = "outreach.resumed" as const;

export type OutreachRefusal =
  /** Not one of the rep's campaigns. */
  | "not_found"
  /** Nobody kept and revealed with drafts is waiting to start. */
  | "nothing_to_start"
  /** The start day is not a calendar day, or is before today in London. */
  | "bad_date"
  /** The start day is more than 30 days ahead. */
  | "too_far"
  /** A repeated request id carrying a different start day from the one it made. */
  | "request_reused";

export class OutreachChangeRefused extends Error {
  constructor(readonly refusal: OutreachRefusal) {
    super(`outreach change refused: ${refusal}`);
    this.name = "OutreachChangeRefused";
  }
}

/** Thrown inside the transaction to roll it back (and its Event) when there is nothing to change; never leaves this module. */
class Unchanged extends Error {
  constructor() {
    super("outreach change: nothing to change");
  }
}

type Tx = Prisma.TransactionClient;
type Owner = { orgId: string; userId: string; campaignId: string };

/** Lock the rep's own campaign for the rest of the transaction. False when it is not theirs. */
async function lockOwn(tx: Tx, input: Owner): Promise<boolean> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM campaigns
     WHERE id = ${input.campaignId} AND org_id = ${input.orgId} AND owner_user_id = ${input.userId}
       FOR UPDATE
  `;
  return rows.length === 1;
}

/**
 * Kept, revealed people with a usable email and a live first email (to review,
 * needs you, or approved), who have no start day yet. A first email that could
 * not be written, or that the rep rejected, starts nobody: the sequence opens on it.
 */
function startableWhere(input: { orgId: string; campaignId: string }): Prisma.CampaignPersonWhereInput {
  return {
    orgId: input.orgId,
    campaignId: input.campaignId,
    status: "chosen",
    review: "kept",
    reveal: { in: ["revealed", "known"] },
    personId: { not: null },
    outreachStartOn: null,
    drafts: { some: { orgId: input.orgId, touch: "email1", state: { in: ["to_review", "needs_you", "approved"] } } },
  };
}

export type StartOutreachInput = Owner & { requestId: string; startOn: IsoDate; now?: () => Date };
export type StartOutreachResult = { people: number; repeated: boolean; startOn: IsoDate };

/**
 * Start outreach: the chosen day on everyone waiting to start. A weekend day
 * becomes the Monday after, and a day more than 30 days ahead is refused. A
 * repeat of the same press (its request id) changes nothing and says how many
 * it started.
 */
export async function startOutreach(db: PrismaClient, input: StartOutreachInput): Promise<StartOutreachResult> {
  const today = londonDay((input.now ?? (() => new Date()))());
  if (!isIsoDate(input.startOn) || input.startOn < today) throw new OutreachChangeRefused("bad_date");
  const startOn = startDayFor(input.startOn);
  if (startOn > addCalendarDays(today, START_HORIZON_DAYS)) throw new OutreachChangeRefused("too_far");
  let repeat: StartOutreachResult | null = null;
  try {
    const started = await mutate(db, {
      orgId: input.orgId,
      actor: { kind: "user", userId: input.userId },
      kind: OUTREACH_STARTED,
      campaignId: input.campaignId,
      before: () => ({ startOn: null }),
      after: (ids: string[]) => ({ requestId: input.requestId, startOn: startOn, people: ids }),
      apply: async (tx) => {
        if (!(await lockOwn(tx, input))) throw new OutreachChangeRefused("not_found");
        const earlier = await tx.event.findFirst({
          where: { orgId: input.orgId, campaignId: input.campaignId, kind: OUTREACH_STARTED, after: { path: ["requestId"], equals: input.requestId } },
        });
        if (earlier !== null) {
          const after = earlier.after as { startOn?: unknown; people?: unknown } | null;
          if (after?.startOn !== startOn) throw new OutreachChangeRefused("request_reused");
          repeat = { people: Array.isArray(after.people) ? after.people.length : 0, repeated: true, startOn };
          throw new Unchanged();
        }
        const people = await tx.campaignPerson.findMany({ where: startableWhere(input), select: { id: true }, orderBy: [{ rank: "asc" }, { id: "asc" }] });
        if (people.length === 0) throw new OutreachChangeRefused("nothing_to_start");
        const ids = people.map((person) => person.id);
        // The null guard again on the write: a day once set is never moved by a later press.
        const updated = await tx.campaignPerson.updateMany({ where: { orgId: input.orgId, campaignId: input.campaignId, id: { in: ids }, outreachStartOn: null }, data: { outreachStartOn: toDbDate(startOn) } });
        if (updated.count !== ids.length) throw new Error("start outreach: a person's start day moved under the lock");
        return ids;
      },
    });
    return { people: started.length, repeated: false, startOn };
  } catch (error) {
    if (error instanceof Unchanged && repeat !== null) return repeat;
    throw error;
  }
}

export type PauseInput = Owner & { paused: boolean; now?: () => Date };

/**
 * Pause or Resume the campaign's outreach. Pressing Pause on a paused campaign
 * (or Resume on a running one) changes nothing and writes no Event.
 */
export async function setOutreachPaused(db: PrismaClient, input: PauseInput): Promise<{ paused: boolean; changed: boolean }> {
  const at = (input.now ?? (() => new Date()))();
  try {
    await mutate(db, {
      orgId: input.orgId,
      actor: { kind: "user", userId: input.userId },
      kind: input.paused ? OUTREACH_PAUSED : OUTREACH_RESUMED,
      campaignId: input.campaignId,
      before: (was: Date | null) => ({ pausedAt: was?.toISOString() ?? null }),
      after: () => ({ pausedAt: input.paused ? at.toISOString() : null }),
      apply: async (tx) => {
        if (!(await lockOwn(tx, input))) throw new OutreachChangeRefused("not_found");
        const campaign = await tx.campaign.findUniqueOrThrow({ where: { id: input.campaignId }, select: { outreachPausedAt: true } });
        if ((campaign.outreachPausedAt !== null) === input.paused) throw new Unchanged();
        await tx.campaign.updateMany({ where: { id: input.campaignId, orgId: input.orgId, ownerUserId: input.userId }, data: { outreachPausedAt: input.paused ? at : null } });
        return campaign.outreachPausedAt;
      },
    });
    return { paused: input.paused, changed: true };
  } catch (error) {
    if (error instanceof Unchanged) return { paused: input.paused, changed: false };
    throw error;
  }
}

/** Where a campaign's outreach is: who is waiting to start, who has any draft, each start day with how many people, and whether it is paused. */
export type OutreachStatus = { startable: number; drafted: number; batches: Array<{ startOn: IsoDate; people: number }>; pausedAt: Date | null };

export async function outreachStatusFor(db: PrismaClient | Tx, input: { orgId: string; campaignId: string }): Promise<OutreachStatus> {
  const campaign = await db.campaign.findFirst({ where: { id: input.campaignId, orgId: input.orgId }, select: { outreachPausedAt: true } });
  const startable = await db.campaignPerson.count({ where: startableWhere(input) });
  const drafted = await db.campaignPerson.count({ where: { orgId: input.orgId, campaignId: input.campaignId, drafts: { some: { orgId: input.orgId } } } });
  const grouped = await db.campaignPerson.groupBy({
    by: ["outreachStartOn"],
    where: { orgId: input.orgId, campaignId: input.campaignId, outreachStartOn: { not: null } },
    _count: { _all: true },
    orderBy: { outreachStartOn: "asc" },
  });
  const batches = grouped.flatMap((row) => (row.outreachStartOn === null ? [] : [{ startOn: fromDbDate(row.outreachStartOn), people: row._count._all }]));
  return { startable, drafted, batches, pausedAt: campaign?.outreachPausedAt ?? null };
}
