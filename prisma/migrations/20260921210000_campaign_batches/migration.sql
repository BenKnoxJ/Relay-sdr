-- P5b (21 Sep 2026): Find more people. Additive only: one column with a
-- default, so every row already there is batch 1 and nothing else changes.
--
-- A campaign's people arrive in batches: the first search is batch 1, and each
-- Find more people adds the next. Review, Reveal, drafting and Start outreach
-- each take one batch; an earlier batch is never touched by a later one.
ALTER TABLE "campaign_people" ADD COLUMN "batch" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "campaign_people" ADD CONSTRAINT "campaign_people_batch_positive" CHECK ("batch" >= 1);
