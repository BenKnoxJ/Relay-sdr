-- Lead gen v2.2 (account-led review): the Research role a candidate plays,
-- and the rep's keep or drop before Reveal. No account table: an account is
-- its people's `company_key`.

-- CreateEnum
CREATE TYPE "campaign_person_review" AS ENUM ('pending', 'kept', 'dropped');

-- CreateEnum
CREATE TYPE "buyer_role_part" AS ENUM ('runs', 'champions', 'signs');

-- CreateEnum
CREATE TYPE "role_match_method" AS ENUM ('exact', 'phrase');

-- AlterTable
ALTER TABLE "campaign_people" ADD COLUMN     "review" "campaign_person_review" NOT NULL DEFAULT 'pending',
ADD COLUMN     "reviewed_at" TIMESTAMP(3),
ADD COLUMN     "reviewed_by_user_id" TEXT,
ADD COLUMN     "role_match" "role_match_method",
ADD COLUMN     "role_part" "buyer_role_part",
ADD COLUMN     "role_title" TEXT;

-- AddForeignKey
ALTER TABLE "campaign_people" ADD CONSTRAINT "campaign_people_reviewed_by_user_id_fkey" FOREIGN KEY ("reviewed_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Not expressible in the Prisma schema, so written here by hand.
--
-- A role is its part, its title and how it matched, all three or none.
ALTER TABLE "campaign_people" ADD CONSTRAINT "campaign_people_role_whole"
  CHECK ((("role_part" IS NULL) = ("role_title" IS NULL)) AND (("role_part" IS NULL) = ("role_match" IS NULL)));
-- A decision says who made it and when; pending says neither.
ALTER TABLE "campaign_people" ADD CONSTRAINT "campaign_people_review_recorded"
  CHECK ((("review" = 'pending') = ("reviewed_at" IS NULL)) AND (("reviewed_at" IS NULL) = ("reviewed_by_user_id" IS NULL)));
