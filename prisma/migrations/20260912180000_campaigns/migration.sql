-- Campaigns, and the research jobs that belong to them.
--
-- The persistence half of Task 6d, cut to what the Start → research → campaign
-- page slice needs: a campaign row with its current brief and brief version,
-- and the job columns that say which campaign and which version a research job
-- is for. No campaign state column (it is derived), no research pack table
-- (the `research.completed` Event is the pack), no pause columns.

-- AlterTable
ALTER TABLE "jobs" ADD COLUMN     "brief_version" INTEGER,
ADD COLUMN     "campaign_id" TEXT;

-- CreateTable
CREATE TABLE "campaigns" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "owner_user_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "brief_version" INTEGER NOT NULL DEFAULT 1,
    "brief" JSONB NOT NULL,
    "start_request_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "campaigns_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "campaigns_org_id_owner_user_id_created_at_idx" ON "campaigns"("org_id", "owner_user_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "campaigns_org_id_start_request_id_key" ON "campaigns"("org_id", "start_request_id");

-- CreateIndex
CREATE INDEX "jobs_org_id_campaign_id_brief_version_created_at_idx" ON "jobs"("org_id", "campaign_id", "brief_version", "created_at");

-- AddForeignKey
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "orgs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "campaigns"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Not expressible in the Prisma schema, so written here by hand.
--
-- A job is research for one version of one campaign's brief, or for no
-- campaign at all: never a campaign with no version, nor a version with no
-- campaign.
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_campaign_brief_version_together"
  CHECK (("campaign_id" IS NULL) = ("brief_version" IS NULL));
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_brief_version_positive"
  CHECK ("brief_version" IS NULL OR "brief_version" >= 1);
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_brief_version_positive"
  CHECK ("brief_version" >= 1);
