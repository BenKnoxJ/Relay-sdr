import { researchBriefSchema } from "../../../agents/research/input.schema";

import { campaignsCopy, startCopy } from "@/lib/copy/campaigns";
import type { CampaignRecord } from "@/lib/repo/campaigns";

import { briefFieldsFrom } from "./brief";
import { deriveResearch } from "./derive";
import { answersFor, chipFor, nextFor, type CampaignCounts, type CampaignState } from "./state";
import type { BriefFields, Campaign, CampaignSummary } from "./types";

/**
 * A stored campaign as its screens draw it.
 *
 * Every downstream value is absent, not zero: until lead gen exists nobody has
 * been found, nothing has been sent and no credit has been spent, and a real
 * campaign shows exactly that in words (`progressNone`, `nothingSentYet`,
 * `answerCostNoCredits`). The only numbers on a real campaign are the ones the
 * rep chose (how many, how long) and what research found.
 */

const MOTIONS: Record<BriefFields["motion"], string> = {
  direct: startCopy.motionDirect,
  channel: startCopy.motionChannel,
};

const CHANNELS: Record<BriefFields["channels"][number], string> = {
  email: startCopy.channelEmail,
  linkedin: startCopy.channelLinkedin,
  calls: startCopy.channelCalls,
};

/** The one grey line under a campaign's name: motion, product, size, channels. */
export function motionLine(brief: BriefFields): string {
  return [
    MOTIONS[brief.motion],
    brief.product,
    `${brief.howMany} ${startCopy.people} ${campaignsCopy.over} ${brief.weeks} ${startCopy.weeks}`,
    brief.channels.map((channel) => CHANNELS[channel]).join(", "),
  ].join(campaignsCopy.noteJoin);
}

export function toCampaign(record: CampaignRecord): Campaign {
  // Written by `createCampaign` from a brief research's schema accepted, so a
  // row that no longer parses is a defect worth failing on, not one to draw.
  const brief = briefFieldsFrom(researchBriefSchema.parse(record.campaign.brief));
  const research = deriveResearch(
    record.job === null ? null : { status: record.job.status, error: record.job.error },
    record.event === null ? null : { after: record.event.after },
  );
  const state: CampaignState = research.state;
  const failure = research.state === "failed" ? research.failure : null;
  const counts: CampaignCounts = {
    progress: null,
    outcomes: null,
    draftsDueToday: 0,
    nextBatch: null,
    credits: null,
    live: true,
    failure,
  };

  return {
    id: record.campaign.id,
    name: record.campaign.name,
    motionLine: motionLine(brief),
    state,
    chip: chipFor(state),
    contacted: null,
    total: brief.howMany,
    ...nextFor(state, counts),
    brief,
    pack: research.state === "planReady" || research.state === "stopped" ? research.pack : null,
    plan: null,
    progress: null,
    people: null,
    outcomes: null,
    draftsDueToday: 0,
    nextBatch: null,
    credits: null,
    ask: answersFor(state, counts),
    live: true,
    failure,
  };
}

export function toSummary(campaign: Campaign): CampaignSummary {
  const { id, name, motionLine: line, state, chip, contacted, total, next, nextIsAction } = campaign;
  return { id, name, motionLine: line, state, chip, contacted, total, next, nextIsAction };
}

/**
 * How the list's header counts itself: "2 running · 1 done". Everything that is
 * neither done nor stopped is still going, which is how the signed mock counts.
 */
export function listCounts(campaigns: readonly Pick<CampaignSummary, "state">[]): { running: number; done: number } {
  return {
    running: campaigns.filter((campaign) => campaign.state !== "done" && campaign.state !== "stopped").length,
    done: campaigns.filter((campaign) => campaign.state === "done").length,
  };
}
