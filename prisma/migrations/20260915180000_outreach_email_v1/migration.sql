-- CreateEnum
CREATE TYPE "outreach_draft_state" AS ENUM ('to_review', 'needs_you', 'failed', 'approved', 'rejected');

-- CreateTable
CREATE TABLE "outreach_drafts" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "campaign_id" TEXT NOT NULL,
    "brief_version" INTEGER NOT NULL,
    "campaign_person_id" TEXT NOT NULL,
    "owner_user_id" TEXT NOT NULL,
    "job_id" TEXT NOT NULL,
    "touch" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "state" "outreach_draft_state" NOT NULL,
    "subject" TEXT,
    "body" TEXT,
    "ask" TEXT,
    "opener" JSONB,
    "claims" TEXT[],
    "findings" JSONB NOT NULL,
    "advice" JSONB NOT NULL,
    "lookup" JSONB NOT NULL,
    "generations" INTEGER NOT NULL,
    "cost_usd" DECIMAL(12,6) NOT NULL DEFAULT 0,
    "edited_body" TEXT,
    "edit_class" TEXT,
    "reject_reason" TEXT,
    "decided_by_user_id" TEXT,
    "decided_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "outreach_drafts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rep_voices" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "samples" JSONB NOT NULL,
    "how_i_write" TEXT NOT NULL DEFAULT '',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "rep_voices_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "outreach_drafts_org_id_owner_user_id_state_idx" ON "outreach_drafts"("org_id", "owner_user_id", "state");

-- CreateIndex
CREATE INDEX "outreach_drafts_org_id_campaign_id_brief_version_idx" ON "outreach_drafts"("org_id", "campaign_id", "brief_version");

-- CreateIndex
CREATE UNIQUE INDEX "outreach_drafts_org_id_job_id_key" ON "outreach_drafts"("org_id", "job_id");

-- CreateIndex
CREATE UNIQUE INDEX "rep_voices_user_id_key" ON "rep_voices"("user_id");

-- AddForeignKey
ALTER TABLE "outreach_drafts" ADD CONSTRAINT "outreach_drafts_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "orgs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outreach_drafts" ADD CONSTRAINT "outreach_drafts_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "campaigns"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outreach_drafts" ADD CONSTRAINT "outreach_drafts_campaign_person_id_fkey" FOREIGN KEY ("campaign_person_id") REFERENCES "campaign_people"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outreach_drafts" ADD CONSTRAINT "outreach_drafts_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outreach_drafts" ADD CONSTRAINT "outreach_drafts_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outreach_drafts" ADD CONSTRAINT "outreach_drafts_decided_by_user_id_fkey" FOREIGN KEY ("decided_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rep_voices" ADD CONSTRAINT "rep_voices_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "orgs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rep_voices" ADD CONSTRAINT "rep_voices_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;



-- Not expressible in the Prisma schema, so written here by hand.
--
-- One draft per person, touch and attempt: a repeated press or a retried job
-- cannot write a second first email for the same person.
CREATE UNIQUE INDEX "outreach_drafts_one_per_attempt" ON "outreach_drafts"("org_id", "campaign_person_id", "touch", "attempt");
-- A written draft has a body and an ask; only a draft that could not be written has neither.
ALTER TABLE "outreach_drafts" ADD CONSTRAINT "outreach_drafts_written"
  CHECK ("state" = 'failed' OR ("body" IS NOT NULL AND "ask" IS NOT NULL AND "opener" IS NOT NULL));
-- A decision says who made it and when; a rejection says why.
ALTER TABLE "outreach_drafts" ADD CONSTRAINT "outreach_drafts_decided"
  CHECK ((("state" IN ('approved', 'rejected')) = ("decided_at" IS NOT NULL)) AND (("decided_at" IS NULL) = ("decided_by_user_id" IS NULL)) AND (("state" = 'rejected') = ("reject_reason" IS NOT NULL)));
-- At most two model generations per draft (outreach v2.1 §6).
ALTER TABLE "outreach_drafts" ADD CONSTRAINT "outreach_drafts_generations" CHECK ("generations" BETWEEN 0 AND 2);
ALTER TABLE "outreach_drafts" ADD CONSTRAINT "outreach_drafts_attempt_positive" CHECK ("attempt" >= 1);
