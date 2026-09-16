-- Outreach drafts: bring the database and schema.prisma into agreement
-- (PR #38 review). Expand-only on the two tables 20260915180000 created:
-- no table, column or index is dropped or renamed.
--
-- `outreach_drafts_one_per_attempt` (20260915180000) is now declared in
-- schema.prisma as `@@unique(..., map: "outreach_drafts_one_per_attempt")`,
-- so it needs no SQL here; the earlier note that Prisma cannot express it was
-- wrong.

-- A claims list is never NULL: Prisma cannot read a NULL scalar list back.
-- Relay always writes a list, so the backfill is a guard, not a data change.
ALTER TABLE "outreach_drafts" ALTER COLUMN "claims" SET DEFAULT ARRAY[]::TEXT[];
UPDATE "outreach_drafts" SET "claims" = ARRAY[]::TEXT[] WHERE "claims" IS NULL;
ALTER TABLE "outreach_drafts" ALTER COLUMN "claims" SET NOT NULL;

-- A rep's voice is written and read within their org.
CREATE UNIQUE INDEX "rep_voices_org_id_user_id_key" ON "rep_voices"("org_id", "user_id");
