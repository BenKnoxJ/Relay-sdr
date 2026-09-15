-- Lead gen Reveal emails (v2.1 §6, §7, §9, §11; v2.2 §9a): what revealing a
-- kept person's email came to, on their campaign row. The email itself is the
-- Person's; the ledger rows are `credit_ledger` rows of kind `reveal`.

-- CreateEnum
CREATE TYPE "campaign_person_reveal" AS ENUM ('revealed', 'known', 'no_email', 'suppressed', 'held', 'failed');

-- A provider record the provider will not reveal for compliance reasons: not
-- bought again, and nothing said about the human reached through another one.
ALTER TYPE "provider_identity_status" ADD VALUE 'restricted';

-- AlterTable
ALTER TABLE "campaign_people" ADD COLUMN     "reveal" "campaign_person_reveal",
ADD COLUMN     "reveal_hold" TEXT,
ADD COLUMN     "revealed_at" TIMESTAMP(3);


-- Not expressible in the Prisma schema, so written here by hand.
--
-- A reveal outcome says when; a hold reason only ever explains an outcome.
ALTER TABLE "campaign_people" ADD CONSTRAINT "campaign_people_reveal_recorded"
  CHECK ((("reveal" IS NULL) = ("revealed_at" IS NULL)) AND ("reveal_hold" IS NULL OR "reveal" IS NOT NULL));
-- An email Relay can use is always a Person's.
ALTER TABLE "campaign_people" ADD CONSTRAINT "campaign_people_reveal_person"
  CHECK ("reveal" IS NULL OR "reveal" NOT IN ('revealed', 'known') OR "person_id" IS NOT NULL);
-- Only a chosen person the rep kept is ever revealed (v2.2 §9a).
ALTER TABLE "campaign_people" ADD CONSTRAINT "campaign_people_reveal_kept"
  CHECK ("reveal" IS NULL OR ("status" = 'chosen' AND "review" = 'kept'));
