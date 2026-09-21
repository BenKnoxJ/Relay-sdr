-- P4 (21 Sep 2026): tracking events. Additive only: one new table, one
-- nullable column, no row changes.
--
-- What the rep recorded on a person's outreach: a step sent, accepted,
-- declined, replied, bounced or done (a call, with what happened), a note, a
-- meeting, an outcome, or an undo naming the row it reverses. Append-only:
-- a correction is a new `undo` row, never an edit. The trigger below refuses
-- an UPDATE or a DELETE outright, so that is a property of the table and not
-- only of the code that writes to it.
CREATE TYPE "outreach_event_kind" AS ENUM ('sent', 'accepted', 'declined', 'replied', 'bounced', 'done', 'note', 'meeting', 'outcome', 'undo');
CREATE TYPE "outreach_outcome" AS ENUM ('not_interested', 'wrong_person', 'bounced', 'closed');
CREATE TYPE "call_result" AS ENUM ('spoke', 'voicemail', 'no_answer', 'wrong_number');

CREATE TABLE "outreach_events" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "campaign_id" TEXT NOT NULL,
    "campaign_person_id" TEXT NOT NULL,
    -- A step id from the sequence template (src/lib/outreach/sequence.ts), or null for a person-level row.
    "step" TEXT,
    "kind" "outreach_event_kind" NOT NULL,
    "outcome" "outreach_outcome",
    "call_result" "call_result",
    "note" TEXT,
    -- A calendar day in Europe/London, as every outreach day is (P3).
    "happened_on" DATE NOT NULL DEFAULT ((now() AT TIME ZONE 'Europe/London'))::date,
    "undoes_event_id" TEXT,
    "by_user_id" TEXT NOT NULL,
    -- Write order: the fold replays rows in it. A sequence value is taken at
    -- insert, after the write path's lock on the person, where created_at is
    -- the transaction's start and two writers can land out of order.
    "seq" SERIAL NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "outreach_events_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "outreach_events_note_length" CHECK ("note" IS NULL OR char_length("note") <= 2000),
    -- An outcome row names one; nothing else carries one.
    CONSTRAINT "outreach_events_outcome" CHECK (("kind" = 'outcome') = ("outcome" IS NOT NULL)),
    -- An undo names the row it reverses; nothing else does.
    CONSTRAINT "outreach_events_undo" CHECK (("kind" = 'undo') = ("undoes_event_id" IS NOT NULL)),
    -- Only a call's done carries what happened on it.
    CONSTRAINT "outreach_events_call_result" CHECK ("call_result" IS NULL OR "kind" = 'done'),
    -- Step rows name a step; person-level rows do not.
    CONSTRAINT "outreach_events_step" CHECK (("kind" IN ('sent', 'accepted', 'declined', 'replied', 'bounced', 'done')) = ("step" IS NOT NULL))
);

-- A row is undone at most once.
CREATE UNIQUE INDEX "outreach_events_undoes_event_id_key" ON "outreach_events"("undoes_event_id");
CREATE UNIQUE INDEX "outreach_events_seq_key" ON "outreach_events"("seq");
CREATE INDEX "outreach_events_org_id_campaign_person_id_seq_idx" ON "outreach_events"("org_id", "campaign_person_id", "seq");
CREATE INDEX "outreach_events_org_id_campaign_id_idx" ON "outreach_events"("org_id", "campaign_id");

ALTER TABLE "outreach_events" ADD CONSTRAINT "outreach_events_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "orgs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "outreach_events" ADD CONSTRAINT "outreach_events_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "campaigns"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "outreach_events" ADD CONSTRAINT "outreach_events_campaign_person_id_fkey" FOREIGN KEY ("campaign_person_id") REFERENCES "campaign_people"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "outreach_events" ADD CONSTRAINT "outreach_events_undoes_event_id_fkey" FOREIGN KEY ("undoes_event_id") REFERENCES "outreach_events"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "outreach_events" ADD CONSTRAINT "outreach_events_by_user_id_fkey" FOREIGN KEY ("by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE FUNCTION "outreach_events_append_only"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'outreach_events is append-only: record an undo instead';
END;
$$;

CREATE TRIGGER "outreach_events_append_only" BEFORE UPDATE OR DELETE ON "outreach_events"
  FOR EACH ROW EXECUTE FUNCTION "outreach_events_append_only"();

-- The rep's number for this person, for the calls (P5's drawer sets it).
ALTER TABLE "campaign_people" ADD COLUMN "phone" TEXT;
ALTER TABLE "campaign_people" ADD CONSTRAINT "campaign_people_phone_length" CHECK ("phone" IS NULL OR char_length("phone") <= 40);
