import { documentedWorstCaseCharge, type SearchPricing } from "@/lib/leadgen/spend";

/**
 * Find more people (P5b): a campaign's people come in batches. The first
 * search is batch 1; each Find more people runs lead gen again on the same
 * play and recipe as the next batch, and that batch goes through the same
 * review, Reveal, drafting and Start outreach. Pure: the repo and the page
 * read the same rules.
 */

/** The batch a lead gen job's input names: 1 unless Find more people asked for a later one. */
export function batchOfInput(input: unknown): number {
  const batch = input !== null && typeof input === "object" ? (input as { batch?: unknown }).batch : undefined;
  return typeof batch === "number" && Number.isInteger(batch) && batch >= 2 ? batch : 1;
}

/** How many people a rep can ask for at once. */
export const MORE_SIZES = [10, 20, 30] as const;
export type MoreSize = (typeof MORE_SIZES)[number];

export const isMoreSize = (value: number): value is MoreSize => (MORE_SIZES as readonly number[]).includes(value);

/** The latest search at the campaign's version, as far as Find more people reads it. */
export type LatestSearch = {
  batch: number;
  /** Still on the queue or running. */
  inFlight: boolean;
  /** It picked people (People found); otherwise it halted or failed. */
  picked: boolean;
  /** Its reveal recorded a result. */
  revealed: boolean;
  /** Write emails was pressed for its people. */
  outreachRequested: boolean;
  /** Start outreach was pressed for its people: someone in it has a start day. */
  started: boolean;
  /** Kept people with a usable email: what Write emails would draft for. Read only before it is pressed. */
  writable: number;
};

/**
 * Whether Find more people is offered, and the batch it would make. Only once
 * the latest batch is finished with, so a new batch never strands an earlier
 * one half way: its emails revealed, and its outreach started (or nobody to
 * write for). A later batch that found nobody, or failed, can be asked for
 * again under the same number; batch 1 that did is Needs you, as before.
 */
export function nextBatch(latest: LatestSearch | null): number | null {
  if (latest === null || latest.inFlight) return null;
  if (latest.picked) return latest.revealed && (latest.outreachRequested ? latest.started : latest.writable === 0) ? latest.batch + 1 : null;
  return latest.batch > 1 ? latest.batch : null;
}

/**
 * About how many search credits a batch of `howMany` uses: what this campaign
 * has used per person chosen so far, scaled up, and never less than one
 * request's documented worst case. An estimate the rep reads, not a limit:
 * the cap is the limit.
 */
export function searchEstimate(howMany: MoreSize, history: { credits: number; people: number }, pricing: SearchPricing): number {
  const oneRequest = documentedWorstCaseCharge(howMany, pricing);
  if (history.people === 0 || history.credits === 0) return oneRequest;
  return Math.max(oneRequest, Math.ceil((history.credits / history.people) * howMany));
}
