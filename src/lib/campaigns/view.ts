import { researchBriefSchema } from "../../../agents/research/input.schema";
import { leadGenHandoffSchema } from "../../../agents/leadgen/input.schema";

import { campaignsCopy, startCopy } from "@/lib/copy/campaigns";
import type { CampaignRecord } from "@/lib/repo/campaigns";

import { briefFieldsFrom, widenedBrief, type ResearchBrief } from "./brief";
import { accountsOf, buyerRolesOf, effectiveOf, revealTallyOf, reviewCounts, searchLine } from "./accounts";
import { becomesLine, widenHeadings } from "./briefLines";
import { deriveLeadGen, deriveResearch, deriveReveal, storedPack, type LeadGenState } from "./derive";
import { researchSections } from "./research";
import { answersFor, chipFor, nextFor, type CampaignCounts, type CampaignState } from "./state";
import type { BriefFields, Campaign, CampaignResearchPage, CampaignSummary, ConfirmPlanView, PeopleFoundView, PeopleNeedsYouView, ResearchActions, WidenChoice } from "./types";

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

/** How finding people is set up where the campaign is drawn: whether Confirm can be pressed, and the limit it approves. */
export type LeadGenOptions = { available: boolean; searchCreditCap: number | null; sample: boolean };
const NO_LEAD_GEN_SETUP: LeadGenOptions = { available: false, searchCreditCap: null, sample: false };

/** Why finding people needs the rep, in words (lead gen v2.1 §11). */
function peopleReasonLine(people: Extract<LeadGenState, { state: "peopleNeedsYou" }>): string {
  const c = campaignsCopy;
  const withTerm = (line: string) => (people.term === undefined ? line : `${line} ${people.term}`);
  switch (people.reason) {
    case "no_candidates":
      return c.haltNoCandidates;
    case "unmappable":
      return withTerm(c.haltUnmappable);
    case "would_widen":
      return c.haltWouldWiden;
    case "choose_industry":
      return withTerm(c.haltChooseIndustry);
    case "over_cap":
      return c.haltOverCap;
    case "balance_unavailable":
      return c.haltBalance;
    case "provider_busy":
      return c.haltBusy;
    case "took_too_long":
      return c.haltTooLong;
    case "failed":
      return c.haltFailed;
  }
}

export function toCampaign(record: CampaignRecord, options: LeadGenOptions = NO_LEAD_GEN_SETUP): Campaign {
  // Written by `createCampaign` from a brief research's schema accepted, so a
  // row that no longer parses is a defect worth failing on, not one to draw.
  const researchBrief = researchBriefSchema.parse(record.campaign.brief);
  const brief = briefFieldsFrom(researchBrief);
  const research = deriveResearch(
    record.job === null ? null : { status: record.job.status, error: record.job.error },
    record.event === null ? null : { after: record.event.after },
  );
  // Once the version is confirmed, finding people is where the campaign is (lead gen v2.1 §11).
  const leadGen = record.leadGen ?? null;
  const confirm = research.state === "planReady" && leadGen !== null ? leadGen.confirm : null;
  const people: LeadGenState | null =
    confirm === null || leadGen === null
      ? null
      : deriveLeadGen(
          leadGen.job === null ? null : { status: leadGen.job.status, error: leadGen.job.error },
          leadGen.result === null ? null : { kind: leadGen.result.kind, after: leadGen.result.after },
        );
  // Once Reveal emails is pressed for this People found, the reveal is where the campaign is (v2.1 §11).
  const revealRecord = people?.state === "peopleFound" ? (leadGen?.reveal ?? null) : null;
  const revealed =
    revealRecord === null
      ? null
      : deriveReveal(revealRecord.job === null ? null : { status: revealRecord.job.status, error: revealRecord.job.error }, revealRecord.result === null ? null : { kind: revealRecord.result.kind });
  const state: CampaignState = revealed?.state ?? people?.state ?? research.state;
  const frozen = confirm === null ? null : leadGenHandoffSchema.safeParse((confirm.after as { handoff?: unknown } | null)?.handoff);
  const handoff = frozen?.success === true ? frozen.data : null;
  const sampleRun = confirm !== null && (confirm.after as { balanceSource?: unknown } | null)?.balanceSource === "sample";
  const spend = leadGen?.spend ?? null;
  const cap = handoff?.spend.searchCreditCap ?? 0;
  const found = people?.state === "peopleFound" ? people.pick : null;
  const plan = found !== null && revealRecord === null ? (leadGen?.revealPlan ?? null) : null;
  const canReveal = state === "peopleFound" && options.available && plan !== null && plan.kept > 0 && plan.toReveal + plan.known > 0;
  const failure = research.state === "failed" ? research.failure : null;
  // Try again puts the failed job back on the queue, so it is offered only
  // when there is a failed job to put back: not for a result Relay could not
  // read, which Edit brief is for.
  const retryable = state === "failed" && record.job?.status === "failed" && record.event === null;
  const widenings = research.state === "stopped" ? widenChoices(researchBrief, research.pack.insufficient?.widenings ?? []) : null;
  const can: ResearchActions = {
    widen: widenings !== null && widenings.some((choice) => choice.usable),
    edit: state === "planReady" || state === "stopped" || state === "failed" || state === "peopleFound" || state === "peopleNeedsYou",
    retry: retryable,
    confirm: state === "planReady" && options.available,
    retryPeople: people?.state === "peopleNeedsYou" && people.retryable,
    chooseIndustry: people?.state === "peopleNeedsYou" && people.choosable,
    review: state === "peopleFound",
    reveal: canReveal,
  };
  const counts: CampaignCounts = {
    progress: found === null ? null : { found: found.found.n, drafted: 0, approved: 0, sent: 0, replied: 0 },
    outcomes: null,
    draftsDueToday: 0,
    nextBatch: null,
    // From the persisted ledger: charged, and what is left under this Confirm's cap.
    credits: confirm === null || spend === null || handoff === null ? null : { used: spend.charged, left: Math.max(0, cap - spend.charged - spend.reserved) },
    live: true,
    failure,
    retryable,
    ...(people?.state === "peopleNeedsYou" ? { peopleReason: peopleReasonLine(people) } : {}),
  };

  const confirmPlan: ConfirmPlanView | null =
    state === "planReady"
      ? {
          available: options.available,
          groupName: research.state === "planReady" ? (research.overview.startWith?.groupName ?? null) : null,
          searchCreditCap: options.searchCreditCap,
          sample: options.sample,
          lawfulBasis: campaignsCopy.lawfulBasis,
        }
      : null;
  const peopleFound: PeopleFoundView | null =
    found === null || handoff === null
      ? null
      : {
          groupName: handoff.buyerGroup.name,
          found: found.found,
          shortfall: found.shortfall ?? null,
          search: searchLine(handoff, effectiveOf(leadGen?.result?.after)),
          buyerRoles: buyerRolesOf(handoff),
          // After Reveal, the kept people only: nobody else was revealed.
          accounts: accountsOf(leadGen?.people ?? [], handoff, revealRecord !== null),
          roles: handoff.version === 2,
          review: reviewCounts(leadGen?.people ?? []),
          onHold: found.holdsApplied.reduce((total, hold) => total + hold.count, 0),
          spend: { charged: spend?.charged ?? 0, reserved: spend?.reserved ?? 0, cap },
          phase: revealed === null ? "review" : revealed.state === "revealing" ? "revealing" : "ready",
          // Kept people only: pending and dropped are never revealed (v2.2 §9a).
          revealPlan: plan,
          revealResult:
            revealRecord === null || revealed === null
              ? null
              : {
                  running: revealed.state === "revealing" && !revealed.stopped,
                  stopped: revealed.state === "revealing" && revealed.stopped,
                  tally: revealTallyOf(leadGen?.people ?? []),
                  charged: revealRecord.spend.charged,
                  reserved: revealRecord.spend.reserved,
                  maxCredits: revealRecord.after?.maxCredits ?? 0,
                  notKept: (leadGen?.people ?? []).filter((row) => row.status === "chosen" && row.review !== "kept").length,
                },
          sample: sampleRun,
        };
  const peopleNeedsYou: PeopleNeedsYouView | null =
    people?.state === "peopleNeedsYou"
      ? { reason: people.reason, line: peopleReasonLine(people), term: people.term ?? null, choices: people.choosable ? people.choices : [] }
      : null;

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
    overview: research.state === "planReady" ? research.overview : null,
    plan: null,
    progress: counts.progress,
    people:
      found === null
        ? null
        : {
            chosen: found.found.n,
            companies: new Set(found.chosen.map((person) => person.companyKey)).size,
            onHold: found.holdsApplied.reduce((total, hold) => total + hold.count, 0),
          },
    outcomes: null,
    draftsDueToday: 0,
    nextBatch: null,
    credits: counts.credits,
    ask: answersFor(state, counts),
    live: true,
    failure,
    briefVersion: record.campaign.briefVersion,
    can,
    widenings,
    confirmPlan,
    peopleFound,
    peopleNeedsYou,
    spentAtThisVersion: spend !== null && spend.charged + spend.reserved > 0,
  };
}

/**
 * A stored campaign's research page (task 19): the whole finished pack, read
 * into the page's parts. Only a finished plan (complete or partial) has one;
 * everything else is null, and the page sends the rep back to the campaign.
 */
export function toCampaignResearch(record: CampaignRecord): CampaignResearchPage {
  const campaign = toCampaign(record);
  const pack = campaign.state === "planReady" && record.event !== null ? storedPack(record.event.after) : null;
  return {
    id: campaign.id,
    name: campaign.name,
    brief: campaign.brief,
    summary: campaign.overview === null ? null : { inShort: campaign.overview.inShort, startWith: campaign.overview.startWith },
    research: pack === null ? null : researchSections(pack),
  };
}

/**
 * A stop's widening options as the rep chooses between them.
 *
 * Each is checked against the brief as it stands, with the same rule the
 * widening itself applies (`widenedBrief`), so an option that could no longer
 * be acted on is drawn but cannot be chosen. What it would change is read off
 * the brief it would make.
 */
export function widenChoices(brief: ResearchBrief, options: readonly unknown[]): WidenChoice[] {
  const checked = options.map((option) => ({ option: option as { dimension: WidenChoice["dimension"]; text: string }, widened: widenedBrief(brief, option) }));
  const headings = widenHeadings(checked.map(({ option }) => option.dimension));
  const before = briefFieldsFrom(brief);
  return checked.map(({ option, widened }, index) => ({
    index,
    dimension: option.dimension,
    heading: headings[index] ?? "",
    text: option.text,
    becomes: widened.ok ? becomesLine(option.dimension, before, briefFieldsFrom(widened.brief)) : null,
    usable: widened.ok,
  }));
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
