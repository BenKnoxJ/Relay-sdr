-- P2 (21 Sep 2026): one `outreach_draft` job drafts a person's whole sequence,
-- so a job writes one draft per touch rather than one draft. The job's unique
-- index widens from (org, job) to (org, job, touch). No row changes: every
-- existing job wrote one draft, which the wider index still admits. The
-- one-per-attempt index (org, person, touch, attempt) is unchanged and still
-- stops a second draft of the same touch for the same person and attempt.

-- CreateIndex
CREATE UNIQUE INDEX "outreach_drafts_org_id_job_id_touch_key" ON "outreach_drafts"("org_id", "job_id", "touch");

-- DropIndex
DROP INDEX "outreach_drafts_org_id_job_id_key";

-- A person past the per-person drafting ceiling (§11, P2) has touches parked
-- for the rep with nothing written: Needs you, not a dead-end failure, and the
-- rep can reject one. The written check admits exactly that case and no other:
-- `needs_you` or `rejected` with no body only when a finding is the ceiling's.
ALTER TABLE "outreach_drafts" DROP CONSTRAINT "outreach_drafts_written";
ALTER TABLE "outreach_drafts" ADD CONSTRAINT "outreach_drafts_written"
  CHECK (
    "state" = 'failed'
    OR ("body" IS NOT NULL AND "ask" IS NOT NULL AND "opener" IS NOT NULL)
    OR ("state" IN ('needs_you', 'rejected') AND "body" IS NULL AND "findings" @> '[{"rule": "cost-cap"}]'::jsonb)
  );
