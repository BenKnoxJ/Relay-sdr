-- P3 (21 Sep 2026): sequence dates, Start outreach and pause. Additive only:
-- two nullable columns, no row changes.
--
-- Each person has their own start day, so a batch added later runs on its own
-- dates beside an earlier one. A calendar day in Europe/London, not an instant:
-- DATE, never a timestamp. Null until Start outreach sets it.
ALTER TABLE "campaign_people" ADD COLUMN "outreach_start_on" DATE;

-- When the rep paused the campaign's outreach; null while it runs. While it is
-- set nothing is due and nothing is sent.
ALTER TABLE "campaigns" ADD COLUMN "outreach_paused_at" TIMESTAMP(3);
