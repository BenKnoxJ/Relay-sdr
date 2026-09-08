import { Prisma, type PrismaClient } from "@prisma/client";

/**
 * The single write path.
 *
 * Master doc §25, rule 4: a state change and its Event commit in one
 * transaction. Written as a convention that is a rule everyone has to remember,
 * that lasts until the first hurried pull request. Written as this function —
 * with the lint in `eslint.config.mjs` closing every other route to a Prisma
 * write — it is a property of the repository instead.
 *
 * Everything outside `src/lib/repo/**` and `src/lib/jobs/queue.ts` goes through
 * here. The queue is the one other writer, and deliberately so: enqueueing a
 * job is not a domain event, and a `job.enqueued` Event for every retry would
 * bury the record it is meant to be.
 */

/**
 * Every kind of Event the codebase writes.
 *
 * A union rather than a bare string: an Event nobody declared is one nobody can
 * query for either, and the compiler is the cheapest place to notice. Adding a
 * kind is a one-line change here, made on purpose.
 */
export type EventKind = "org.created" | "user.upserted" | "account.connected" | "account.disconnected";

/**
 * Who caused the change. `system` is the worker acting on its own — a poll, a
 * reaper pass, a scheduled send — and carries no user, which is why
 * `Event.actorUserId` is nullable.
 */
export type Actor = { kind: "user"; userId: string } | { kind: "system" };

export type Mutation<T> = {
  orgId: string;
  actor: Actor;
  kind: EventKind;
  /** Set when the change belongs to a campaign or a person, for the timeline. */
  campaignId?: string | null;
  personId?: string | null;
  /** The edit diff §25 asks for. Omit both for a change that has no shape. */
  before?: Prisma.InputJsonValue;
  after?: Prisma.InputJsonValue;
  /**
   * When the thing happened, if that is not now — a provider's timestamp on a
   * polled reply, a backfill. Left out, the Event is stamped at insert, which
   * is the case almost every caller has. `Event.createdAt` records the insert
   * either way, so the two can always be told apart.
   */
  at?: Date;
  /**
   * The state change itself. It receives the transaction client, and must use
   * it: a write issued on the outer client from in here is outside the
   * transaction and defeats the whole arrangement.
   */
  apply: (tx: Prisma.TransactionClient) => Promise<T>;
};

/**
 * Run `apply` and record its Event in one transaction, and return whatever
 * `apply` returned.
 *
 * Either both land or neither does. That is the point, and it holds in both
 * directions: an `apply` that throws rolls the Event back, and an Event that
 * cannot be written (a bad `orgId`, a constraint) rolls the state change back.
 */
export async function mutate<T>(db: PrismaClient, mutation: Mutation<T>): Promise<T> {
  const { orgId, actor, kind, campaignId, personId, before, after, at, apply } = mutation;

  // The types say these are non-empty; JavaScript callers, an `as` cast and a
  // value that arrived from a request body all say otherwise. An Event with a
  // blank kind is an unqueryable record of nothing, and a blank `orgId` is a
  // row outside every tenant — both worth failing on rather than storing.
  if (kind.trim() === "") throw new Error("mutate: kind is required");
  if (orgId.trim() === "") throw new Error("mutate: orgId is required");

  return db.$transaction(async (tx) => {
    const result = await apply(tx);

    // After the change, not before: the Event is the record of something that
    // happened, and on this ordering a constraint violation in `apply` never
    // gets one written for it.
    await tx.event.create({
      data: {
        orgId,
        kind,
        actorKind: actor.kind,
        actorUserId: actor.kind === "user" ? actor.userId : null,
        campaignId: campaignId ?? null,
        personId: personId ?? null,
        // Omitted rather than passed as null: the column is NOT NULL with a
        // `now()` default, so `undefined` takes the default and `null` would
        // be an error.
        ...(at === undefined ? {} : { at }),
        // `DbNull` writes SQL NULL. Prisma's other null, `JsonNull`, writes the
        // JSON value `null`, which would make "no diff recorded" and "the diff
        // was null" the same row.
        before: before ?? Prisma.DbNull,
        after: after ?? Prisma.DbNull,
      },
    });

    return result;
  });
}
