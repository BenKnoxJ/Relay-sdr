import type { Event, Job } from "@prisma/client";

import type { ResearchBrief } from "@/lib/campaigns/brief";
import { nameFrom, toResearchBrief } from "@/lib/campaigns/brief";
import type { Campaign } from "@/lib/campaigns/types";
import { toCampaign } from "@/lib/campaigns/view";
import type { CampaignRecord } from "@/lib/repo/campaigns";

import { briefFields, completePack, partialBrief, partialPack, playablePartialPack, stoppedBrief, stoppedPack } from "../../lib/campaignPacks";

/**
 * Real campaigns, built the way the router builds them (`toCampaign` over a
 * campaign row, its latest research job and that job's Event), without a
 * database. The research results are the contract data in
 * `tests/lib/campaignPacks.ts`.
 */

/** `unreadable` is research that finished with nothing Relay could read: needs you, and no Try again. */
/** `noplay` is a finished pack that ranked no play Relay can search: research needs you, with the pack still readable. */
export type LiveKind = "researching" | "complete" | "partial" | "noplay" | "stopped" | "failed" | "unreadable";

const AT = new Date("2026-09-12T12:00:00Z");

export function liveCampaign(kind: LiveKind): Campaign {
  const brief: ResearchBrief =
    kind === "stopped"
      ? (stoppedBrief() as ResearchBrief)
      : kind === "partial" || kind === "noplay"
        ? (partialBrief() as ResearchBrief)
        : toResearchBrief(briefFields());
  const pack = kind === "complete" ? completePack() : kind === "partial" ? playablePartialPack() : kind === "noplay" ? partialPack() : kind === "stopped" ? stoppedPack() : null;

  const campaign = {
    id: `camp-${kind}`,
    orgId: "org_live",
    ownerUserId: "user_live",
    name: nameFrom(brief.who),
    briefVersion: 1,
    brief,
    startRequestId: `req-${kind}`,
    createdAt: AT,
    updatedAt: AT,
  };
  const job = {
    id: `job-${kind}`,
    status: kind === "researching" ? "running" : kind === "failed" ? "failed" : "done",
    error: kind === "failed" ? "research: took_too_long — a rail was reached" : null,
  } as Job;
  const event = pack === null ? null : ({ id: `event-${kind}`, after: { jobId: job.id, pack: JSON.parse(JSON.stringify(pack)) } } as unknown as Event);

  return toCampaign({ campaign, job, event } as unknown as CampaignRecord);
}
