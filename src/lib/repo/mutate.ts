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
  /// A rep changed a campaign's brief: a chosen widening or an edit. `before`
  /// and `after` carry the brief and its version either side, `after.cause`
  /// says which, and the research job for the new version is enqueued in the
  /// same transaction.
  | "campaign.brief_changed"
  /// A rep ticked plays on Plan ready (Relay P1): the first stays on this
  /// campaign and each other becomes a new campaign reading this one's
  /// research, each with its own `campaign.created`, in the same transaction.
  | "campaign.plays_chosen"
  /// A rep pressed Try again on research that failed: the failed job went
  /// back on the queue, at the same brief version with the same input.
  | "campaign.research_retried"
  /// A rep pressed Confirm plan: `after.handoff` is the frozen
  /// `LeadGenHandoff` (V1 under lead gen v2.1 §3, V2 under v2.2 §3a) with the lawful-basis record, and
  /// the lead gen job for the version is enqueued in the same transaction.
  | "campaign.confirmed"
  /// A lead gen job found people: `after.output` is the People found result.
  | "leadgen.picked"
  /// A lead gen job stopped with a reason for the rep (v2.1 §11).
  | "leadgen.halted"
  /// A rep asked lead gen to run again at the same version: Try again, or a
  /// chosen industry. The new job is enqueued in the same transaction.
  | "leadgen.rerun"
  /// A rep pressed Find more people (P5b): `after` has the batch, how many,
  /// and, when the rep approved a new search cap, the cap and the balance read
  /// for it. The batch's lead gen job is enqueued in the same transaction.
  | "campaign.more_people"
  /// A rep kept or dropped people found, one person or a whole account
  /// (lead gen v2.2 §9a). `before` has each changed person's previous review,
  /// `after` the decision and who it covered; the rows change in the same
  /// transaction.
  | "campaign.people_reviewed"
  /// A rep pressed Reveal emails, the second spend gate (lead gen v2.1 §6,
  /// v2.2 §9a): `after` has the kept people it covers, the counts and the
  /// credit maximum the rep saw, and the balance read for it; the reveal job
  /// is enqueued in the same transaction.
  | "campaign.reveal_confirmed"
  /// A reveal job finished: each kept person's outcome is on their campaign
  /// row, the Person and provider records are written in the same
  /// transaction, and `after` has the counts. No email is in the Event.
  | "leadgen.revealed"
  /// A reveal that failed before any request left Relay, put back on the queue (product-truth foundation, 2026-09-15).
  | "campaign.reveal_retried"
  /// A rep pressed Write emails (outreach v2.1): one `outreach_draft` job per
  /// kept person with a usable email, enqueued in the same transaction.
  | "outreach.requested"
  /// A draft job ran its lookup: `after` holds the lookup result, so a retried
  /// job reads it back rather than searching again (§4 replay).
  | "outreach.lookup"
  /// A draft job finished: the draft is written (to review, needs you, or
  /// could not be written) in the same transaction.
  | "outreach.drafted"
  /// A rep pressed Start outreach (Relay P3): `after` has the start day and
  /// the people it was set on; their rows change in the same transaction.
  | "outreach.started"
  /// A rep paused a campaign's outreach: nothing is due or sent until resumed.
  | "outreach.paused"
  /// A rep resumed a paused campaign's outreach.
  | "outreach.resumed"
  /// A rep recorded something on a person's outreach (Relay P4): a step
  /// marked, a note, a meeting, an outcome. `after` is the `outreach_events`
  /// row, written in the same transaction.
  | "outreach.tracked"
  /// A rep undid one of those: `after` is the undo row naming the one it reverses.
  | "outreach.undone"
  /// A rep set or cleared a person's phone number; `before` and `after` carry it.
  | "outreach.phone_set"
  /// The rep rejected a draft with a reason (§9); a redraft, when the reason
  /// asks for one, is enqueued in the same transaction.
  | "draft.rejected"
  /// A rep saved their voice samples and "how I write" note (master §15 v0).
  | "rep.voice_saved"
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
  /**
   * The edit diff §25 asks for. Omit both for a change that has no shape.
   *
   * Either may also be read off what `apply` returned, for a change whose
   * before and after are only known once `apply` has read the row it locked.
   */
  before?: Prisma.InputJsonValue | ((result: T) => Prisma.InputJsonValue);
  after?: Prisma.InputJsonValue | ((result: T) => Prisma.InputJsonValue);
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
    const eventBefore = typeof before === "function" ? before(result) : before;
    const eventAfter = typeof after === "function" ? after(result) : after;

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
        before: eventBefore ?? Prisma.DbNull,
        after: eventAfter ?? Prisma.DbNull,
      },
    });

    return result;
  });
}
