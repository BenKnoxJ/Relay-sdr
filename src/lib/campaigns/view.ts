import { researchBriefSchema } from "../../../agents/research/input.schema";
import { leadGenHandoffSchema } from "../../../agents/leadgen/input.schema";

import { campaignsCopy, startCopy } from "@/lib/copy/campaigns";
import type { CampaignRecord } from "@/lib/repo/campaigns";

import { batchOfInput } from "./batches";
import { briefFieldsFrom, widenedBrief, type ResearchBrief } from "./brief";
import { accountsOf, buyerRolesOf, effectiveOf, revealTallyOf, reviewCounts, rolesMissingFrom, searchLine, spareCount } from "./accounts";
import type { FindingView } from "./types";
import { becomesLine, widenHeadings } from "./briefLines";
import { overviewOf } from "./overview";
import { candidateById, groupName } from "./packSelectors";
import { deriveLeadGen, deriveResearch, deriveReveal, leadGenResultOf, storedPack, type LeadGenState } from "./derive";
import { executablePlayCount, playFactsOf, playsOf, rankedPlays } from "./plays";
import type { ResearchResultFacts, StageResult } from "./stage";
import { isAttention } from "./stage";
import type { OutreachFacts } from "./stage";
import { revealLedgerOf, spendOf, summaryFactsOf, type PeopleGroup, type SummaryInput } from "./summary";
import { researchSections } from "./research";
import { chipFor, haltLine, nextFor, type CampaignCounts } from "./state";
import type { BriefFields, Campaign, CampaignResearchPage, CampaignSummary, CampaignSummaryFacts, ConfirmPlanView, DraftStateView, PeopleFoundView, PeopleNeedsYouView, WidenChoice } from "./types";

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
  return haltLine(people.reason, people.term);
}

/** The chip and the "next" line: a stopped reveal draws as revealing but reads as needing the rep. */
function headline(derived: StageResult, counts: CampaignCounts): { chip: string; next: string; nextIsAction: boolean } {
  if (derived.stage === "reveal_needs_you") return { chip: campaignsCopy.chipNeedsYou, next: campaignsCopy.nextRevealNeedsYou, nextIsAction: true };
  if (derived.stage === "drafts_ready") return derived.attention === null ? { chip: campaignsCopy.chipDraftsReady, next: campaignsCopy.nextDraftsReady, nextIsAction: true } : { chip: campaignsCopy.chipNeedsYou, next: campaignsCopy.nextFailed, nextIsAction: true };
  if (derived.stage === "ready_to_send") return { chip: campaignsCopy.chipReadyToSend, next: campaignsCopy.nextReadyToSend, nextIsAction: false };
  if (derived.stage === "drafting") return { chip: campaignsCopy.chipDrafting, next: campaignsCopy.nextDrafting, nextIsAction: false };
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
  // A made campaign's play by name (Relay P1), as the list reads it.
  const chosen = facts === null || pack === null || record.campaign.playId === null ? undefined : candidateById(pack, record.campaign.playId);
  const play = chosen === undefined || pack === null ? undefined : groupName(pack, chosen.archetypeId);
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
  const outreach: OutreachFacts | null = revealRecord === null || revealRecord.result === null ? null : outreachFactsOf(leadGen?.people ?? [], leadGen?.outreach ?? null);
  return {
    campaign: { id: record.campaign.id, name: record.campaign.name, briefVersion: record.campaign.briefVersion, createdAt: record.campaign.createdAt, updatedAt: record.campaign.updatedAt },
    stage: {
      research: { job: record.job, result: researchResult },
      confirmed: leadGen?.confirm !== null && leadGen?.confirm !== undefined,
      leadGen: leadGen === null || leadGen.confirm === null ? null : { job: leadGen.job, result },
      reveal: revealRecord === null ? null : { job: revealRecord.job, hasResult: revealRecord.result !== null, ledger: revealLedgerOf(ledger, revealRecord.confirm.id) },
      revealPlan: revealRecord === null && plan !== null ? { kept: plan.kept, toReveal: plan.toReveal, known: plan.known } : null,
      leadGenAvailable: options.available,
      outreach,
    },
    research:
      researchResult === null || !researchResult.readable
        ? null
        : researchResult.outcome === "insufficient"
          ? { outcome: "insufficient", plays: 0, viablePlays: 0 }
          : {
              outcome: researchResult.outcome,
              plays: facts === null ? 0 : rankedPlays(facts).length,
              viablePlays: researchResult.executablePlays,
              ...(play === undefined ? {} : { play }),
            },
    confirmed:
      handoff === null
        ? null
        : { groupId: handoff.buyerGroup.id, groupName: handoff.buyerGroup.name, playId: handoff.version === 2 ? handoff.play.id : null, sourceRank: handoff.buyerGroup.sourceRank },
    people,
    spend: spendOf(ledger, record.researchCost ?? [], {
      briefVersion: record.campaign.briefVersion,
      // The search limit spent against now: the newest a later batch approved, else the Confirm's (P5b).
      searchCap: handoff === null ? null : (leadGen?.searchCap ?? handoff.spend.searchCreditCap),
      searchApprovalId: leadGen?.searchApprovalId ?? null,
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
  // A later batch approved with a new cap reads against that cap (P5b).
  const cap = leadGen?.searchCap ?? handoff?.spend.searchCreditCap ?? 0;
  const found = people?.state === "peopleFound" ? people.pick : null;
  const plan = found !== null && revealRecord === null ? (leadGen?.revealPlan ?? null) : null;
  const failure = derived.failure;
  const widenings = research.state === "stopped" ? widenChoices(researchBrief, research.pack.insufficient?.widenings ?? []) : null;
  const can = derived.can;
  // Once Write emails is pressed, each person's first email is where it is (outreach v2.1).
  const outreach = revealed?.state === "peopleReady" ? (leadGen?.outreach ?? null) : null;
  const draftStates = outreach?.requested === true ? outreach.byPerson : null;
  const writable = facts.stage === "people_ready" ? writableCount(leadGen?.people ?? []) : 0;
  const counts: CampaignCounts = {
    progress: found === null ? null : { found: found.found.n, drafted: 0, approved: 0, sent: 0, replied: 0 },
    outcomes: null,
    draftsDueToday: 0,
    nextBatch: null,
    // From the persisted ledger: this version's search, charged, and what is left under this Confirm's cap.
    credits: confirm === null || spend === null || handoff === null ? null : { used: spend.charged, left: Math.max(0, cap - spend.charged - spend.reserved) },
    live: true,
  };
  const pack = record.event === null ? null : storedPack(record.event.after);
  // A campaign made for one play (Relay P1) shows and confirms that play only.
  const playId = record.campaign.playId;
  const allPlays = pack === null || pack.insufficient !== undefined ? null : playsOf(pack);
  const plays = allPlays === null || playId === null ? allPlays : allPlays.filter((play) => play.id === playId);

  // Start with and the pain are the campaign's own play's, not research's top one.
  const overview = research.state !== "planReady" ? null : playId === null || pack === null ? research.overview : overviewOf(pack, playId);

  const confirmPlan: ConfirmPlanView | null =
    state === "planReady"
      ? {
          available: options.available,
          groupName: overview?.startWith?.groupName ?? null,
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
          accounts: accountsOf(leadGen?.people ?? [], handoff, revealRecord !== null, draftStates ?? undefined),
          roles: handoff.version === 2,
          review: reviewCounts(leadGen?.people ?? []),
          onHold: found.holdsApplied.reduce((total, hold) => total + hold.count, 0),
          inOtherCampaign: found.holdsApplied.find((hold) => hold.reason === "in_other_campaign")?.count ?? 0,
          spare: spareCount(leadGen?.people ?? []),
          rolesMissing: rolesMissingFrom(buyerRolesOf(handoff), leadGen?.people ?? []),
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
          drafts: draftStates === null ? null : draftCounts(draftStates),
          writable,
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
    overview,
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
    live: true,
    failure,
    briefVersion: record.campaign.briefVersion,
    batch: leadGen?.job === null || leadGen?.job === undefined ? 1 : batchOfInput(leadGen.job.input),
    can,
    widenings,
    confirmPlan,
    peopleFound,
    peopleNeedsYou,
    spentAtThisVersion: spend !== null && spend.charged + spend.reserved > 0,
    plays: plays,
    playId,
    // Only on the campaign research ran on, before a play was chosen, and when there is more than one to choose.
    canCreatePlays:
      state === "planReady" && playId === null && record.campaign.researchFromCampaignId === null && (plays ?? []).filter((play) => play.executable).length > 1,
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

/** Kept people with a usable email: who Write emails would draft for. */
function writableCount(rows: readonly { status: string; review: string; reveal?: string | null }[]): number {
  return rows.filter((row) => row.status === "chosen" && row.review === "kept" && (row.reveal === "revealed" || row.reveal === "known")).length;
}

/** The outreach facts the stage reads, from the rows and the outreach record: never a count of work that has not happened. */
function outreachFactsOf(rows: readonly { status: string; review: string; reveal?: string | null }[], outreach: { requested: boolean; byPerson: Record<string, string>; jobs: { queued: number; running: number } } | null): OutreachFacts {
  const drafts = { to_review: 0, needs_you: 0, failed: 0, approved: 0, rejected: 0 };
  for (const state of Object.values(outreach?.byPerson ?? {})) if (state in drafts) drafts[state as keyof typeof drafts] += 1;
  return { writable: writableCount(rows), requested: outreach?.requested === true, jobs: outreach?.jobs ?? { queued: 0, running: 0 }, drafts };
}

/** First emails counted by where they are (outreach v2.1). */
function draftCounts(byPerson: Record<string, string>): Record<DraftStateView, number> {
  const counts: Record<DraftStateView, number> = { writing: 0, to_review: 0, needs_you: 0, failed: 0, approved: 0, rejected: 0 };
  for (const state of Object.values(byPerson)) if (state in counts) counts[state as DraftStateView] += 1;
  return counts;
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
