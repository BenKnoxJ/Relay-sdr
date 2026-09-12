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
export type EventKind =
  | "org.created"
  | "user.upserted"
  /// A rep began a connect: the OAuth state was minted. The absence of an
  /// `account.connected` after one of these is what an abandoned consent
  /// screen looks like.
  | "account.connect_started"
  | "account.connected"
  | "account.disconnected"
  /// The rep lowered their own daily cap, within the ceiling their admin set.
  | "account.cap_changed"
  /// The provider refused a refresh: the mailbox needs re-linking.
  | "account.expiring"
  /// A refresh rotated the stored tokens. Not a change the rep made, and not
  /// one they see, but the blob it replaces is the only key to a mailbox and
  /// "when did this token last rotate" has to be answerable.
  | "account.token_refreshed"
  /// A job did something outside the database that cannot be undone.
  | "side_effect.recorded"
  /// An org activated a version of a product facts file; `after` carries the
  /// hash the pointer was pinned at and whether the file was still a draft.
  | "facts.activated"
  /// A research job produced a validated pack; `after` carries the pack, the
  /// provenance report and what the run ran under. Until Task 6d's table,
  /// this Event *is* where the pack lives.
  | "research.completed"
  /// A rep started a campaign: `after` carries its name, brief version 1 and
  /// the brief. Written in the same transaction as the campaign row and its
  /// first research job, so "started" and "research asked for" are one fact.
  | "campaign.created"
  /// A run reached drafts ready: there is something for a rep to approve, and
  /// the run that produced it has ended. §24's approval hand-off is these three
  /// kinds and nothing else — no suspended run, no in-process state, just the
  /// record that the work stopped here.
  | "draft.ready"
  /// A rep approved a draft. Written in the same transaction as the job that
  /// acts on it, which is what makes "approved" and "will be sent" one fact.
  | "draft.approved"
  /// The send half ran and recorded what it sent.
  | "send.recorded";

/**
 * Who caused the change. `system` is the worker acting on its own — a poll, a
 * reaper pass, a scheduled send — and carries no user, which is why
 * `Event.actorUserId` is nullable.
 */
export type Actor = { kind: "user"; userId: string } | { kind: "system" };

export type Mutation<T> = {
  /**
   * The tenant the change belongs to. It must come from the session — Task 8
   * derives it there — and never from request input: this function trusts what
   * it is given, so a caller that forwards a body field lets one tenant write
   * into another.
   */
  orgId: string;
  actor: Actor;
  kind: EventKind;
  /**
   * Set when the change belongs to a campaign or a person, for the timeline.
   *
   * `campaignId` may also be read off what `apply` returned, for the change
   * that creates the campaign: its id is the row's own (a cuid, like every
   * other table's), which does not exist until `apply` has written it. The
   * Event is written after `apply` either way.
   */
  // A callback takes its parameter type from the caller's annotation: `apply`'s
  // own parameter is contextually typed, so it cannot be the only source of `T`.
  campaignId?: string | null | ((result: T) => string | null);
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
    const eventCampaignId = typeof campaignId === "function" ? campaignId(result) : (campaignId ?? null);

    // After the change, not before: the Event is the record of something that
    // happened, and on this ordering a constraint violation in `apply` never
    // gets one written for it.
    await tx.event.create({
      data: {
        orgId,
        kind,
        actorKind: actor.kind,
        actorUserId: actor.kind === "user" ? actor.userId : null,
        campaignId: eventCampaignId,
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
