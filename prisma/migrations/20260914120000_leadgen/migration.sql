-- People and credits for lead gen (lead gen v2.1 §6, §9).
--
-- Person is the org's canonical contact with a revealed email; ProviderIdentity
-- is one provider record and whether it is usable; CampaignPerson is a
-- campaign's enrolment/candidate record; ContactSuppression is the only
-- org-wide suppression (opt-out, do-not-contact); the credit ledger holds every
-- search charge, reserved at its documented worst case before the call.
-- No campaign state column: state stays derived.

-- CreateEnum
CREATE TYPE "provider_identity_status" AS ENUM ('usable', 'no_email', 'invalid_id', 'wrong_person');

-- CreateEnum
CREATE TYPE "campaign_person_status" AS ENUM ('chosen', 'spare');

-- CreateEnum
CREATE TYPE "campaign_person_source" AS ENUM ('bought', 'reused');

-- CreateEnum
CREATE TYPE "contact_suppression_kind" AS ENUM ('email', 'domain');

-- CreateEnum
CREATE TYPE "contact_suppression_reason" AS ENUM ('opted_out', 'dnc');

-- CreateEnum
CREATE TYPE "credit_kind" AS ENUM ('search', 'reveal');

-- CreateEnum
CREATE TYPE "credit_state" AS ENUM ('reserved', 'reconciled', 'unreconciled');

-- CreateTable
CREATE TABLE "people" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "email_type" TEXT NOT NULL,
    "grade" TEXT,
    "name" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "people_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "provider_identities" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "provider" "provider" NOT NULL,
    "provider_id" TEXT NOT NULL,
    "person_id" TEXT,
    "status" "provider_identity_status" NOT NULL DEFAULT 'usable',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "provider_identities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "campaign_people" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "campaign_id" TEXT NOT NULL,
    "brief_version" INTEGER NOT NULL,
    "job_id" TEXT NOT NULL,
    "provider" "provider" NOT NULL,
    "provider_id" TEXT NOT NULL,
    "person_id" TEXT,
    "status" "campaign_person_status" NOT NULL,
    "source" "campaign_person_source" NOT NULL,
    "rank" INTEGER NOT NULL,
    "score" INTEGER NOT NULL,
    "why_picked" TEXT NOT NULL,
    "company_key" TEXT NOT NULL,
    "preview" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "campaign_people_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contact_suppressions" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "kind" "contact_suppression_kind" NOT NULL,
    "value" TEXT NOT NULL,
    "reason" "contact_suppression_reason" NOT NULL,
    "source" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "contact_suppressions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credit_ledger" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "campaign_id" TEXT NOT NULL,
    "brief_version" INTEGER NOT NULL,
    "confirm_event_id" TEXT NOT NULL,
    "job_id" TEXT NOT NULL,
    "kind" "credit_kind" NOT NULL,
    "key" TEXT NOT NULL,
    "worst_case" INTEGER NOT NULL,
    "charged" INTEGER,
    "state" "credit_state" NOT NULL DEFAULT 'reserved',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "credit_ledger_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "people_org_id_email_key" ON "people"("org_id", "email");

-- CreateIndex
CREATE UNIQUE INDEX "provider_identities_org_id_provider_provider_id_key" ON "provider_identities"("org_id", "provider", "provider_id");

-- CreateIndex
CREATE INDEX "campaign_people_org_id_campaign_id_brief_version_rank_idx" ON "campaign_people"("org_id", "campaign_id", "brief_version", "rank");

-- CreateIndex
CREATE UNIQUE INDEX "campaign_people_org_id_campaign_id_brief_version_provider_p_key" ON "campaign_people"("org_id", "campaign_id", "brief_version", "provider", "provider_id");

-- CreateIndex
CREATE UNIQUE INDEX "contact_suppressions_org_id_kind_value_key" ON "contact_suppressions"("org_id", "kind", "value");

-- CreateIndex
CREATE INDEX "credit_ledger_org_id_confirm_event_id_idx" ON "credit_ledger"("org_id", "confirm_event_id");

-- CreateIndex
CREATE INDEX "credit_ledger_org_id_created_at_idx" ON "credit_ledger"("org_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "credit_ledger_org_id_key_key" ON "credit_ledger"("org_id", "key");

-- AddForeignKey
ALTER TABLE "people" ADD CONSTRAINT "people_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "orgs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "provider_identities" ADD CONSTRAINT "provider_identities_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "orgs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "provider_identities" ADD CONSTRAINT "provider_identities_person_id_fkey" FOREIGN KEY ("person_id") REFERENCES "people"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_people" ADD CONSTRAINT "campaign_people_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "orgs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_people" ADD CONSTRAINT "campaign_people_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "campaigns"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_people" ADD CONSTRAINT "campaign_people_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_people" ADD CONSTRAINT "campaign_people_person_id_fkey" FOREIGN KEY ("person_id") REFERENCES "people"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contact_suppressions" ADD CONSTRAINT "contact_suppressions_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "orgs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_ledger" ADD CONSTRAINT "credit_ledger_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "orgs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_ledger" ADD CONSTRAINT "credit_ledger_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "campaigns"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_ledger" ADD CONSTRAINT "credit_ledger_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Not expressible in the Prisma schema, so written here by hand.
--
-- One canonical human is never enrolled twice in one campaign's brief
-- version, once their identity has resolved to a Person (v2.1 §9).
CREATE UNIQUE INDEX "campaign_people_one_person_per_version"
  ON "campaign_people"("campaign_id", "brief_version", "person_id")
  WHERE "person_id" IS NOT NULL;

-- One address is one Person: emails are stored lower case.
ALTER TABLE "people" ADD CONSTRAINT "people_email_lower_case" CHECK ("email" = lower("email"));

ALTER TABLE "campaign_people" ADD CONSTRAINT "campaign_people_brief_version_positive" CHECK ("brief_version" >= 1);
ALTER TABLE "campaign_people" ADD CONSTRAINT "campaign_people_rank_positive" CHECK ("rank" >= 1);

-- Every reservation is worth something, and a charge is never negative.
ALTER TABLE "credit_ledger" ADD CONSTRAINT "credit_ledger_worst_case_positive" CHECK ("worst_case" >= 1);
ALTER TABLE "credit_ledger" ADD CONSTRAINT "credit_ledger_charged_non_negative" CHECK ("charged" IS NULL OR "charged" >= 0);
-- A reconciled row has the provider's charge; an open or unknown one does not.
ALTER TABLE "credit_ledger" ADD CONSTRAINT "credit_ledger_charged_when_reconciled"
  CHECK (("state" = 'reconciled') = ("charged" IS NOT NULL));
