-- One campaign per play (Relay P1). Additive only: three nullable columns on
-- `campaigns`, a foreign key and a CHECK. Nothing is dropped, renamed or
-- rewritten, and every existing row reads as it did (all three NULL).

-- AlterTable
ALTER TABLE "campaigns" ADD COLUMN     "play_id" TEXT,
ADD COLUMN     "research_from_brief_version" INTEGER,
ADD COLUMN     "research_from_campaign_id" TEXT;

-- AddForeignKey
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_research_from_campaign_id_fkey" FOREIGN KEY ("research_from_campaign_id") REFERENCES "campaigns"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Not expressible in the Prisma schema, so written here by hand.
--
-- A campaign reads another's research at one brief version of it, or reads
-- its own: never a source with no version, nor a version with no source.
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_research_from_together"
  CHECK (("research_from_campaign_id" IS NULL) = ("research_from_brief_version" IS NULL));
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_research_from_version_positive"
  CHECK ("research_from_brief_version" IS NULL OR "research_from_brief_version" >= 1);
