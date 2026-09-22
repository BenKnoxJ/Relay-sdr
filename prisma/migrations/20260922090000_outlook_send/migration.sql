-- P7 (22 Sep 2026): send approved emails from the rep's Outlook. Additive
-- only: three defaulted columns on users, one new enum and one new table. No
-- row changes, no drops, no renames.
--
-- users.email_*: how the rep's sent emails look. The font is one of a fixed
-- list checked in the app; the size is bounded here too. The signature is
-- stored already sanitised (src/lib/outreach/emailHtml.ts).
--
-- outreach_sends: one row per person and email step, written before Microsoft
-- is called. Its unique key is the double-press guard.
-- CreateEnum
CREATE TYPE "outreach_send_state" AS ENUM ('sending', 'sent', 'unverified', 'failed');

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "email_font" TEXT NOT NULL DEFAULT 'Aptos',
ADD COLUMN     "email_font_size" INTEGER NOT NULL DEFAULT 11,
ADD COLUMN     "email_signature" TEXT NOT NULL DEFAULT '',
ADD CONSTRAINT "users_email_font_size" CHECK ("email_font_size" BETWEEN 8 AND 20),
ADD CONSTRAINT "users_email_signature_length" CHECK (char_length("email_signature") <= 20000);

-- CreateTable
CREATE TABLE "outreach_sends" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "campaign_id" TEXT NOT NULL,
    "campaign_person_id" TEXT NOT NULL,
    "step" TEXT NOT NULL,
    "by_user_id" TEXT NOT NULL,
    "state" "outreach_send_state" NOT NULL,
    "graph_draft_id" TEXT,
    "message_id" TEXT,
    "internet_message_id" TEXT,
    "conversation_id" TEXT,
    "claimed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "failure" TEXT,
    "sent_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "outreach_sends_pkey" PRIMARY KEY ("id"),
    -- A sent row carries the ids a follow-up replies to.
    CONSTRAINT "outreach_sends_sent_ids" CHECK ("state" <> 'sent' OR ("message_id" IS NOT NULL AND "conversation_id" IS NOT NULL AND "sent_at" IS NOT NULL))
);

-- CreateIndex
CREATE INDEX "outreach_sends_org_id_by_user_id_created_at_idx" ON "outreach_sends"("org_id", "by_user_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "outreach_sends_org_id_campaign_person_id_step_key" ON "outreach_sends"("org_id", "campaign_person_id", "step");

-- AddForeignKey
ALTER TABLE "outreach_sends" ADD CONSTRAINT "outreach_sends_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "orgs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outreach_sends" ADD CONSTRAINT "outreach_sends_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "campaigns"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outreach_sends" ADD CONSTRAINT "outreach_sends_campaign_person_id_fkey" FOREIGN KEY ("campaign_person_id") REFERENCES "campaign_people"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outreach_sends" ADD CONSTRAINT "outreach_sends_by_user_id_fkey" FOREIGN KEY ("by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

