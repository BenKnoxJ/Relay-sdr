import { researchBriefSchema } from "../../../agents/research/input.schema";
import { leadGenHandoffSchema } from "../../../agents/leadgen/input.schema";

import { campaignsCopy, startCopy } from "@/lib/copy/campaigns";
import type { CampaignRecord } from "@/lib/repo/campaigns";

import { briefFieldsFrom, widenedBrief, type ResearchBrief } from "./brief";
import { accountsOf, buyerRolesOf, effectiveOf, revealTallyOf, reviewCounts, searchLine } from "./accounts";
import type { FindingView } from "./types";
import { becomesLine, widenHeadings } from "./briefLines";
import { deriveLeadGen, deriveResearch, deriveReveal, leadGenResultOf, storedPack, type LeadGenState } from "./derive";
import { executablePlayCount, playFactsOf, playsOf, rankedPlays } from "./plays";
import type { ResearchResultFacts, StageResult } from "./stage";
import { isAttention } from "./stage";
import { revealLedgerOf, spendOf, summaryFactsOf, type PeopleGroup, type SummaryInput } from "./summary";
import { researchSections } from "./research";
import { answersFor, chipFor, nextFor, type CampaignCounts } from "./state";
import type { BriefFields, Campaign, CampaignResearchPage, CampaignSummary, CampaignSummaryFacts, ConfirmPlanView, PeopleFoundView, PeopleNeedsYouView, WidenChoice } from "./types";

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

/** Why revealing emails stopped, in words, by what Relay knows about its spend. */
function revealStoppedLine(reason: string | undefined): string {
  switch (reason) {
    case "reveal_failed":
      return campaignsCopy.revealStoppedRetry;
    case "reveal_spend_unresolved":
      return campaignsCopy.revealStoppedHeld;
    case "reveal_failed_terminal":
      return campaignsCopy.revealStoppedFailed;
    default:
      return campaignsCopy.revealStopped;
  }
}

/** The chip and the "next" line: a stopped reveal draws as revealing but reads as needing the rep. */
function headline(derived: StageResult, counts: CampaignCounts): { chip: string; next: string; nextIsAction: boolean } {
  if (derived.stage === "reveal_needs_you") return { chip: campaignsCopy.chipNeedsYou, next: campaignsCopy.nextRevealNeedsYou, nextIsAction: true };
  return { chip: chipFor(derived.state), ...nextFor(derived.state, counts) };
}

/**
 * The summary's inputs from the whole record the campaign page loads: the
 * same facts the list builds from its grouped queries, so the page and the
 * list derive the same stage and count the same people and spend.
 */
function summaryInputOf(record: CampaignRecord, brief: ResearchBrief, options: LeadGenOptions): SummaryInput {
  const pack = record.event === null ? null : storedPack(record.event.after);
  const leadGen = record.leadGen ?? null;
  const frozen = leadGen?.confirm === null || leadGen?.confirm === undefined ? null : leadGenHandoffSchema.safeParse((leadGen.confirm.after as { handoff?: unknown } | null)?.handoff);
  const handoff = frozen?.success === true ? frozen.data : null;
  const result = leadGen?.result === null || leadGen?.result === undefined ? null : leadGenResultOf({ kind: leadGen.result.kind, after: leadGen.result.after });
  const revealRecord = result?.kind === "picked" ? (leadGen?.reveal ?? null) : null;
  const ledger = record.ledger ?? [];
  const facts = pack === null || pack.insufficient !== undefined ? null : playFactsOf(pack);
  const researchResult: ResearchResultFacts | null =
    record.event === null
      ? null
      : pack === null
        ? { readable: false }
        : pack.insufficient !== undefined
          ? { readable: true, outcome: "insufficient", usableWidenings: widenChoices(brief, pack.insufficient.widenings).filter((choice) => choice.usable).length }
          : { readable: true, outcome: pack.partial ? "partial" : "complete", executablePlays: facts === null ? 0 : executablePlayCount(facts) };
  const people: PeopleGroup[] | null =
    result?.kind === "picked"
      ? (leadGen?.people ?? []).map((row) => ({ status: row.status, review: row.review, reveal: row.reveal, rolePart: row.rolePart, companyKey: row.companyKey, count: 1 }))
      : null;
  const plan = leadGen?.revealPlan ?? null;
  return {
    campaign: { id: record.campaign.id, name: record.campaign.name, briefVersion: record.campaign.briefVersion, createdAt: record.campaign.createdAt, updatedAt: record.campaign.updatedAt },
    stage: {
      research: { job: record.job, result: researchResult },
      confirmed: leadGen?.confirm !== null && leadGen?.confirm !== undefined,
      leadGen: leadGen === null || leadGen.confirm === null ? null : { job: leadGen.job, result },
      reveal: revealRecord === null ? null : { job: revealRecord.job, hasResult: revealRecord.result !== null, ledger: revealLedgerOf(ledger, revealRecord.confirm.id) },
      revealPlan: revealRecord === null && plan !== null ? { kept: plan.kept, toReveal: plan.toReveal, known: plan.known } : null,
      leadGenAvailable: options.available,
    },
    research:
      researchResult === null || !researchResult.readable
        ? null
        : researchResult.outcome === "insufficient"
          ? { outcome: "insufficient", plays: 0, viablePlays: 0 }
          : { outcome: researchResult.outcome, plays: facts === null ? 0 : rankedPlays(facts).length, viablePlays: researchResult.executablePlays },
    confirmed:
      handoff === null
        ? null
        : { groupId: handoff.buyerGroup.id, groupName: handoff.buyerGroup.name, playId: handoff.version === 2 ? handoff.play.id : null, sourceRank: handoff.buyerGroup.sourceRank },
    people,
    spend: spendOf(ledger, record.researchCost ?? [], {
      briefVersion: record.campaign.briefVersion,
      searchCap: handoff?.spend.searchCreditCap ?? null,
      revealMax: revealRecord?.after?.maxCredits ?? null,
    }),
  };
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
  // One derivation for the stage, what the rep can do and what the server will accept.
  const { facts, derived } = summaryFactsOf(summaryInputOf(record, researchBrief, options));
  const state = derived.state;
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
  const frozen = confirm === null ? null : leadGenHandoffSchema.safeParse((confirm.after as { handoff?: unknown } | null)?.handoff);
  const handoff = frozen?.success === true ? frozen.data : null;
  const sampleRun = confirm !== null && (confirm.after as { balanceSource?: unknown } | null)?.balanceSource === "sample";
  const spend = leadGen?.spend ?? null;
  const cap = handoff?.spend.searchCreditCap ?? 0;
  const found = people?.state === "peopleFound" ? people.pick : null;
  const plan = found !== null && revealRecord === null ? (leadGen?.revealPlan ?? null) : null;
  const failure = derived.failure;
  const retryable = derived.can.retry;
  const widenings = research.state === "stopped" ? widenChoices(researchBrief, research.pack.insufficient?.widenings ?? []) : null;
  const can = derived.can;
  const counts: CampaignCounts = {
    progress: found === null ? null : { found: found.found.n, drafted: 0, approved: 0, sent: 0, replied: 0 },
    outcomes: null,
    draftsDueToday: 0,
    nextBatch: null,
    // From the persisted ledger: this version's search, charged, and what is left under this Confirm's cap.
    credits: confirm === null || spend === null || handoff === null ? null : { used: spend.charged, left: Math.max(0, cap - spend.charged - spend.reserved) },
    spend: facts.spend,
    live: true,
    failure,
    retryable,
    ...(people?.state === "peopleNeedsYou" ? { peopleReason: peopleReasonLine(people) } : {}),
    ...(derived.stage === "reveal_needs_you" ? { revealStopped: revealStoppedLine(derived.attention?.reason) } : {}),
  };
  const pack = record.event === null ? null : storedPack(record.event.after);

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
    ...headline(derived, counts),
    contacted: null,
    total: brief.howMany,
    facts,
    brief,
    // The research pack leaves the server only for a stop, which draws what it found and the ways to widen.
    // A plan is read through `overview` and `plays`; the whole pack is on the research page.
    pack: research.state === "stopped" ? research.pack : null,
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
    plays: pack === null || pack.insufficient !== undefined ? null : playsOf(pack),
    spend: facts.spend,
    finding: findingOf(derived.stage, handoff, leadGen?.job ?? null, facts.spend),
  };
}

/**
 * A stored campaign's research page (task 19): the whole finished pack, read
 * into the page's parts. Only a finished plan (complete or partial) has one;
 * everything else is null, and the page sends the rep back to the campaign.
 */
export function toCampaignResearch(record: CampaignRecord): CampaignResearchPage {
  const campaign = toCampaign(record);
  // A finished plan, and a finished pack whose plays cannot be searched: what research found is still the rep's to read.
  const pack = (campaign.state === "planReady" || campaign.failure === "no_play") && record.event !== null ? storedPack(record.event.after) : null;
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

/** Finding people while it runs, from the frozen handoff and the ledger; null in every other stage. */
function findingOf(stage: string, handoff: ReturnType<typeof leadGenHandoffSchema.parse> | null, job: { createdAt?: Date } | null, spend: CampaignSummaryFacts["spend"]): FindingView | null {
  if (stage !== "finding_people" || handoff === null || job === null) return null;
  return {
    groupName: handoff.buyerGroup.name,
    search: searchLine(handoff, null),
    buyerRoles: buyerRolesOf(handoff),
    seedFirms: handoff.seedFirms.length,
    since: job.createdAt instanceof Date ? job.createdAt.toISOString() : null,
    credits: { cap: handoff.spend.searchCreditCap, charged: spend.search.charged, held: spend.search.held },
  };
}

export function toSummary(campaign: Campaign): CampaignSummary {
  const { id, name, motionLine: line, state, chip, contacted, total, next, nextIsAction, facts } = campaign;
  return { id, name, motionLine: line, state, chip, contacted, total, next, nextIsAction, ...(facts === undefined ? {} : { facts }) };
}

/**
 * A list row from the summary's inputs alone (`campaignSummariesForOwner`):
 * no pack, no people and nothing org-wide is loaded, and the stage, chip and
 * line come from the same derivation as the campaign page.
 */
export function summaryRowOf(campaign: { brief: unknown }, input: SummaryInput): CampaignSummary {
  const brief = briefFieldsFrom(researchBriefSchema.parse(campaign.brief));
  const { facts, derived } = summaryFactsOf(input);
  const counts: CampaignCounts = { progress: null, outcomes: null, draftsDueToday: 0, nextBatch: null, credits: null, live: true };
  return {
    id: facts.id,
    name: facts.name,
    motionLine: motionLine(brief),
    state: derived.state,
    ...headline(derived, counts),
    contacted: null,
    total: brief.howMany,
    facts,
  };
}

/**
 * How the list's header counts itself: "2 running · 1 needs you · 1 done". A
 * campaign that needs the rep (a stop included) is never counted as running.
 */
export function listCounts(campaigns: readonly Pick<CampaignSummary, "state" | "facts">[]): { running: number; needsYou: number; done: number } {
  const needsYou = (campaign: Pick<CampaignSummary, "state" | "facts">) =>
    campaign.facts !== undefined ? isAttention(campaign.facts.stage) : campaign.state === "failed" || campaign.state === "stopped" || campaign.state === "peopleNeedsYou";
  return {
    running: campaigns.filter((campaign) => campaign.state !== "done" && !needsYou(campaign)).length,
    needsYou: campaigns.filter(needsYou).length,
    done: campaigns.filter((campaign) => campaign.state === "done").length,
  };
}

export type { CampaignSummaryFacts };
