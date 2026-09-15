import { TRPCError } from "@trpc/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { PackShape } from "../../agents/research/output.schema";
import { authCopy } from "@/lib/copy/auth";
import { campaignsCopy, startCopy } from "@/lib/copy/campaigns";
import { prisma } from "@/lib/db";
import { recordResearchCompleted } from "@/lib/repo/research";
import { appRouter } from "@/server/api/root";
import { type TRPCContext } from "@/server/api/trpc";
import { type Session } from "@/server/auth/session";
import { ensureUser, type Actor } from "@/server/auth/upsertUser";

import { emptyAll, resetDatabase } from "../db/harness";
import { EMPTY_SCOPE } from "@/lib/campaigns/start";

import { completePack, partialPack, startInput, stoppedPack } from "../lib/campaignPacks";

/**
 * The campaigns router: the real router over the real database, with only the
 * identity provider stubbed (the seam `tests/api/runs.test.ts` uses). Research
 * results are written the way the research handler writes them, through
 * `recordResearchCompleted`, so every screen state here is one a real job can
 * produce. No research is run.
 */

vi.mock("@clerk/nextjs/server", () => ({
  auth: async () => ({ userId: null }),
  currentUser: async () => null,
}));

beforeAll(async () => {
  await resetDatabase();
}, 120_000);

afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(async () => {
  await emptyAll();
});

function contextFor(session: Session | null): TRPCContext {
  let pending: Promise<Actor> | undefined;
  return {
    prisma,
    headers: new Headers(),
    session,
    actor: () => {
      if (session === null) return Promise.reject(new Error("not signed in"));
      return (pending ??= ensureUser(prisma, session));
    },
  };
}

const caller = (session: Session | null) => appRouter.createCaller(contextFor(session));
const sessionOf = (clerkId: string, email: string): Session => ({ clerkId, profile: async () => ({ email, name: null }) });

/** First in from the domain is the admin; the next is a rep. */
const boss = () => sessionOf("user_boss", "boss@example.test");
const rep = () => sessionOf("user_rep", "rep@example.test");
const stranger = () => sessionOf("user_stranger", "stranger@other.test");

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return "ok";
  } catch (error) {
    if (error instanceof TRPCError) return error.code;
    throw error;
  }
}

/** The rep's campaign and its research job, straight after Start. */
async function started(session: Session = rep()) {
  const { id } = await caller(session).campaigns.create(startInput());
  const job = await prisma.job.findFirstOrThrow({ where: { campaignId: id } });
  return { id, job };
}

/** Research finishing, written as the research handler writes it. */
async function finish(job: { id: string; orgId: string }, pack: PackShape, outcome: "complete" | "partial" | "insufficient") {
  await recordResearchCompleted(prisma, {
    orgId: job.orgId,
    jobId: job.id,
    runId: "run_test",
    pack: JSON.parse(JSON.stringify(pack)),
    report: {},
    facts: { product: "insights360", version: 2, hash: "test", draft: false },
    knowledge: { product: "insights360", version: 1, hash: "test" },
    partial: pack.partial,
    missingModules: [...pack.missingModules],
    outcome,
    scope: JSON.parse(JSON.stringify(pack.scope ?? {})),
  });
  await prisma.job.update({ where: { id: job.id }, data: { status: "done" } });
}

describe("campaigns.create", () => {
  it("@proof refuses a caller with no session", async () => {
    await expect(caller(null).campaigns.create(startInput())).rejects.toThrow(authCopy.signedOut);
    expect(await prisma.campaign.count()).toBe(0);
  });

  it("starts a campaign and its research, and says where to go", async () => {
    await ensureUser(prisma, boss());
    const { id } = await caller(rep()).campaigns.create(startInput({ who: "Practice owners at vets in Orkney " }));

    const campaign = await prisma.campaign.findUniqueOrThrow({ where: { id } });
    expect(campaign.name).toBe("Practice owners at vets in Orkney");
    expect(campaign.brief).toMatchObject({ who: "Practice owners at vets in Orkney ", region: "GB" });
    expect(await prisma.job.count({ where: { campaignId: id, briefVersion: 1, kind: "research" } })).toBe(1);
  });

  it("returns the same campaign for the same press", async () => {
    const input = startInput();
    const first = await caller(rep()).campaigns.create(input);
    const again = await caller(rep()).campaigns.create(input);
    expect(again.id).toBe(first.id);
    expect(await prisma.campaign.count()).toBe(1);
  });

  it("turns away a brief research would refuse, in the copy file's words, and writes nothing", async () => {
    const backwards = startInput({ scope: { extraCountries: [], places: [], orgTypes: [], size: { unit: "employees", min: 50, max: 5 }, rolesInclude: [], rolesExclude: [] } });
    await expect(caller(rep()).campaigns.create(backwards)).rejects.toThrow(startCopy.cannotStart);
    expect(await codeOf(caller(rep()).campaigns.create(startInput({ howMany: 15 })))).toBe("BAD_REQUEST");
    expect(await prisma.campaign.count()).toBe(0);
    expect(await prisma.job.count()).toBe(0);
  });
});

describe("campaigns.get and campaigns.list", () => {
  it("draws a new campaign as Researching, with nothing downstream pretending to have happened", async () => {
    const { id } = await started();
    const campaign = await caller(rep()).campaigns.get({ id });

    expect(campaign).toMatchObject({
      state: "researching",
      chip: campaignsCopy.chipResearching,
      live: true,
      failure: null,
      pack: null,
      contacted: null,
      total: 10,
      plan: null,
      progress: null,
      people: null,
      outcomes: null,
      credits: null,
      nextBatch: null,
    });
    expect(campaign.brief.who).toBe("Practice owners at independent vets in Orkney");
    const answers = Object.fromEntries(campaign.ask.map((a) => [a.id, a.answer]));
    expect(answers["how-going"]).toBe(campaignsCopy.answerNothingFound);
    expect(answers.cost).toBe(campaignsCopy.answerCostNoCredits);
  });

  it("@proof shows a campaign to its owner only: another rep and another org get NOT_FOUND", async () => {
    await ensureUser(prisma, boss());
    const { id } = await started(rep());

    expect(await codeOf(caller(boss()).campaigns.get({ id }))).toBe("NOT_FOUND");
    expect(await codeOf(caller(stranger()).campaigns.get({ id }))).toBe("NOT_FOUND");
    expect(await codeOf(caller(rep()).campaigns.get({ id: "not-a-campaign" }))).toBe("NOT_FOUND");
    expect((await caller(boss()).campaigns.list()).campaigns).toEqual([]);
  });

  it("lists the rep's campaigns newest first, with the header's counts", async () => {
    const first = await started();
    const second = await started();

    const { campaigns, counts } = await caller(rep()).campaigns.list();
    expect(campaigns.map((c) => c.id)).toEqual([second.id, first.id]);
    // Counted by what each campaign needs, never "running" for everything unfinished.
    expect(counts).toEqual({ needsYou: 0, working: 2, decide: 0, ready: 0, done: 0 });
    expect(campaigns[0]).toMatchObject({ contacted: null, next: campaignsCopy.nextResearching, nextIsAction: false });
  });

  it("is Plan ready when research completes, with the plan cards from the real pack", async () => {
    const { id, job } = await started();
    await finish(job, completePack(), "complete");

    const campaign = await caller(rep()).campaigns.get({ id });
    expect(campaign.state).toBe("planReady");
    expect(campaign.pack?.archetypes.length).toBe(3);
    expect(campaign.pack?.partial).toBe(false);
    expect(campaign.next).toBe(campaignsCopy.nextPlanReadyLive);
  });

  it("is research incomplete, and needs the rep, when a partial pack ranked no play", async () => {
    const { id, job } = await started();
    await finish(job, partialPack(), "partial");

    const campaign = await caller(rep()).campaigns.get({ id });
    // No ranked play means nothing to confirm: not Plan ready (product-truth pass).
    expect(campaign.state).toBe("planIncomplete");
    expect(campaign.can.confirm).toBe(false);
    expect(campaign.pack?.partial).toBe(true);
    expect(campaign.pack?.missingModules.length).toBeGreaterThan(0);
    expect(campaign.overview?.partial.length).toBeGreaterThan(0);
    expect((await caller(rep()).campaigns.list()).counts.needsYou).toBe(1);
  });

  it("is Stopped on an insufficient result, with the evidence it cites and research's own options", async () => {
    const { id, job } = await started();
    const pack = stoppedPack();
    await finish(job, pack, "insufficient");

    const campaign = await caller(rep()).campaigns.get({ id });
    expect(campaign.state).toBe("stopped");
    expect(campaign.pack?.insufficient?.widenings).toEqual(pack.insufficient!.widenings);
    expect(campaign.pack?.stopEvidence?.map((item) => item.id)).toEqual(pack.insufficient!.evidenceIds);
    expect((await caller(rep()).campaigns.list()).counts).toEqual({ needsYou: 1, working: 0, decide: 0, ready: 0, done: 0 });
  });

  it("needs the rep when research failed, and gives the reason in words", async () => {
    const { id, job } = await started();
    await prisma.job.update({ where: { id: job.id }, data: { status: "failed", error: "research: took_too_long — a rail was reached before any module was written" } });

    const campaign = await caller(rep()).campaigns.get({ id });
    expect(campaign).toMatchObject({ state: "failed", failure: "took_too_long", chip: campaignsCopy.chipNeedsYou, pack: null });
    const why = campaign.ask.find((a) => a.id === "why-stopped")?.answer;
    expect(why).toBe(campaignsCopy.failedTookTooLong);
    expect(JSON.stringify(campaign)).not.toContain("rail was reached");
  });
});

/**
 * Widen, Edit brief and Try again through the router (orchestrator A1, items
 * 4 to 6): the codes and lines a page can show, and what the page is drawn
 * from afterwards. The transactions themselves are `tests/repo/campaignChanges.test.ts`.
 */
describe("campaigns.research", () => {
  it("reads a finished plan whole, and gives nothing while research is still reading", async () => {
    const { id, job } = await started();
    expect(await caller(rep()).campaigns.research({ id })).toMatchObject({ id, research: null });

    await finish(job, completePack(), "complete");
    const page = await caller(rep()).campaigns.research({ id });
    expect(page.id).toBe(id);
    expect(page.research?.who.groups).toHaveLength(3);
  });

  it("reads a partial plan too, naming what was not written and ranking nothing research did not rank", async () => {
    const { id, job } = await started();
    await finish(job, partialPack(), "partial");
    // No ranked play, so the campaign is research incomplete; its research is still readable whole.
    expect((await caller(rep()).campaigns.get({ id })).state).toBe("planIncomplete");
    const page = await caller(rep()).campaigns.research({ id });
    expect(page.research?.partial).toEqual(partialPack().missingModules);
    expect(page.research?.unwritten.pains).toEqual(["m05", "m06"]);
    expect(page.research?.who.groups.length).toBeGreaterThan(0);
    expect(page.research?.who.groups.every((group) => group.rank === null && group.whyNow === null)).toBe(true);
  });

  it("opens the printed pack with what the campaign page shows: the same brief, In short and Start with", async () => {
    const { id, job } = await started();
    await finish(job, completePack(), "complete");
    const campaign = await caller(rep()).campaigns.get({ id });
    const page = await caller(rep()).campaigns.research({ id });
    expect(page.brief).toEqual(campaign.brief);
    expect(page.summary).toEqual({ inShort: campaign.overview?.inShort, startWith: campaign.overview?.startWith });
  });

  it("@proof puts the campaign's stored brief under the cover's who to reach: the rep's words, not research's reading of them", async () => {
    const who = "Heads of claims at UK motor insurers, in the rep's own words ";
    const { id } = await caller(rep()).campaigns.create(startInput({ who }));
    const job = await prisma.job.findFirstOrThrow({ where: { campaignId: id } });
    await finish(job, completePack(), "complete");

    const stored = (await prisma.campaign.findUniqueOrThrow({ where: { id } })).brief as { who: string };
    const page = await caller(rep()).campaigns.research({ id });
    expect(stored.who).toBe(who);
    expect(page.brief.who).toBe(stored.who);
    // None of research's own descriptions of who to reach: the rep summary, the kinds of buyer, the ideal company.
    expect(page.summary?.inShort.lines).not.toContain(who);
    expect(page.research?.who.intro).not.toBe(who);
    expect(page.research?.who.groups.map((group) => group.name)).not.toContain(who);
  });

  it("@proof is a read and nothing more: the page and its printed pack write no Event, job, run or change", async () => {
    const { id, job } = await started();
    await finish(job, completePack(), "complete");
    const everything = async () => ({
      campaigns: await prisma.campaign.findMany({ select: { id: true, briefVersion: true, brief: true, updatedAt: true } }),
      events: await prisma.event.count(),
      jobs: await prisma.job.findMany({ select: { id: true, status: true, attempts: true, updatedAt: true } }),
      runs: await prisma.agentRun.count(),
      steps: await prisma.agentRunStep.count(),
      sideEffects: await prisma.sideEffect.count(),
    });
    const before = await everything();
    await caller(rep()).campaigns.research({ id });
    await caller(rep()).campaigns.research({ id });
    expect(await everything()).toEqual(before);
  });

  it("@proof shows a campaign's research to its owner only: another rep and another org get NOT_FOUND", async () => {
    await ensureUser(prisma, boss());
    const { id, job } = await started(rep());
    await finish(job, completePack(), "complete");

    expect(await codeOf(caller(boss()).campaigns.research({ id }))).toBe("NOT_FOUND");
    expect(await codeOf(caller(stranger()).campaigns.research({ id }))).toBe("NOT_FOUND");
    expect(await codeOf(caller(rep()).campaigns.research({ id: "not-a-campaign" }))).toBe("NOT_FOUND");
    expect(await codeOf(caller(null).campaigns.research({ id }))).not.toBe("ok");
  });
});

describe("campaigns.widen, campaigns.editBrief and campaigns.retry", () => {
  /** Start's card for brief C: veterinary practices in Orkney, the scope the signed stop was made for. */
  const vetsInOrkney = () =>
    startInput({
      who: "veterinary practices in Orkney",
      scope: { ...EMPTY_SCOPE, places: [{ name: "Orkney", aliases: ["Orkney Islands", "Kirkwall", "Stromness"] }], orgTypes: ["veterinary practice"] },
    });

  async function stoppedCampaign() {
    const { id } = await caller(rep()).campaigns.create(vetsInOrkney());
    const job = await prisma.job.findFirstOrThrow({ where: { campaignId: id } });
    await finish(job, stoppedPack(), "insufficient");
    return id;
  }

  const uuid = () => crypto.randomUUID();

  it("draws a stop's options as a choice: research's words, numbered headings, and what each would change", async () => {
    const id = await stoppedCampaign();
    const campaign = await caller(rep()).campaigns.get({ id });
    const options = stoppedPack().insufficient!.widenings;

    expect(campaign.can).toEqual({ widen: true, edit: true, retry: false, confirm: false, choosePlay: false, retryPeople: false, chooseIndustry: false, review: false, reveal: false });
    expect(campaign.briefVersion).toBe(1);
    expect(campaign.widenings?.map((choice) => choice.text)).toEqual(options.map((option) => option.text));
    expect(campaign.widenings?.map((choice) => choice.heading)).toEqual([
      `${campaignsCopy.widenRegion}${campaignsCopy.noteJoin}${campaignsCopy.widenOption} 1`,
      `${campaignsCopy.widenRegion}${campaignsCopy.noteJoin}${campaignsCopy.widenOption} 2`,
      campaignsCopy.widenSector,
    ]);
    expect(new Set(campaign.widenings?.map((choice) => choice.becomes)).size).toBe(3);
    expect(campaign.widenings?.every((choice) => choice.usable)).toBe(true);
    expect(campaign.next).toBe(campaignsCopy.nextStopped);
  });

  it("@proof widens by the option chosen, and refuses a stale page, a future version and another rep", async () => {
    const id = await stoppedCampaign();

    expect(await caller(rep()).campaigns.widen({ campaignId: id, fromBriefVersion: 1, optionIndex: 1, requestId: uuid() })).toEqual({ id });
    const after = await caller(rep()).campaigns.get({ id });
    expect(after).toMatchObject({ state: "researching", briefVersion: 2, can: { widen: false, edit: false, retry: false }, widenings: null });
    expect(after.brief.scope.places.map((place) => place.name)).toEqual(["Orkney", "Shetland", "Western Isles", "Highland", "Argyll and Bute"]);

    await expect(caller(rep()).campaigns.widen({ campaignId: id, fromBriefVersion: 1, optionIndex: 0, requestId: uuid() })).rejects.toMatchObject({
      code: "CONFLICT",
      message: campaignsCopy.changedSince,
    });
    await expect(caller(rep()).campaigns.widen({ campaignId: id, fromBriefVersion: 7, optionIndex: 0, requestId: uuid() })).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: campaignsCopy.cannotChange,
    });
    expect(await codeOf(caller(boss()).campaigns.widen({ campaignId: id, fromBriefVersion: 2, optionIndex: 0, requestId: uuid() }))).toBe("NOT_FOUND");
    expect(await codeOf(caller(stranger()).campaigns.widen({ campaignId: id, fromBriefVersion: 2, optionIndex: 0, requestId: uuid() }))).toBe("NOT_FOUND");
    expect(await codeOf(caller(null).campaigns.widen({ campaignId: id, fromBriefVersion: 2, optionIndex: 0, requestId: uuid() }))).toBe("UNAUTHORIZED");
  });

  it("edits the brief from Plan ready, and refuses an unchanged brief and research still reading", async () => {
    const { id, job } = await started();
    await finish(job, completePack(), "complete");
    expect((await caller(rep()).campaigns.get({ id })).can).toEqual({ widen: false, edit: true, retry: false, confirm: false, choosePlay: false, retryPeople: false, chooseIndustry: false, review: false, reveal: false });

    await expect(caller(rep()).campaigns.editBrief({ campaignId: id, fromBriefVersion: 1, requestId: uuid(), brief: startInput().brief })).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: campaignsCopy.briefUnchanged,
    });
    const brief = { ...startInput().brief, howMany: 30 };
    expect(await caller(rep()).campaigns.editBrief({ campaignId: id, fromBriefVersion: 1, requestId: uuid(), brief })).toEqual({ id });
    const after = await caller(rep()).campaigns.get({ id });
    expect(after).toMatchObject({ state: "researching", briefVersion: 2, brief: { howMany: 30 } });

    await expect(caller(rep()).campaigns.editBrief({ campaignId: id, fromBriefVersion: 2, requestId: uuid(), brief: startInput().brief })).rejects.toMatchObject({
      code: "CONFLICT",
    });
    // A brief Start would refuse is refused here in Start's words.
    await expect(
      caller(rep()).campaigns.editBrief({ campaignId: id, fromBriefVersion: 2, requestId: uuid(), brief: { ...startInput().brief, howMany: 15 } }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("offers Try again only when the research itself failed, and puts that job back on the queue", async () => {
    const { id, job } = await started();
    await prisma.job.update({ where: { id: job.id }, data: { status: "failed", error: "research: bad_output — x", attempts: 1 } });
    const before = await caller(rep()).campaigns.get({ id });
    expect(before.can).toEqual({ widen: false, edit: true, retry: true, confirm: false, choosePlay: false, retryPeople: false, chooseIndustry: false, review: false, reveal: false });
    expect(before.ask.find((a) => a.id === "waiting")?.answer).toBe(campaignsCopy.answerWaitingFailed);

    expect(await caller(rep()).campaigns.retry({ campaignId: id, briefVersion: 1, requestId: uuid() })).toEqual({ id });
    expect(await caller(rep()).campaigns.get({ id })).toMatchObject({ state: "researching", briefVersion: 1 });
    expect(await prisma.job.findMany({ where: { campaignId: id } })).toMatchObject([{ id: job.id, status: "queued" }]);
    await expect(caller(rep()).campaigns.retry({ campaignId: id, briefVersion: 1, requestId: uuid() })).rejects.toMatchObject({ code: "CONFLICT" });

    // Research that finished with nothing Relay could read needs the rep too, but there is no failed job to put back.
    const other = await started();
    await prisma.job.update({ where: { id: other.job.id }, data: { status: "done" } });
    const unreadable = await caller(rep()).campaigns.get({ id: other.id });
    expect(unreadable).toMatchObject({ state: "failed", can: { widen: false, edit: true, retry: false } });
    expect(unreadable.ask.find((a) => a.id === "waiting")?.answer).toBe(campaignsCopy.answerWaitingFailedEdit);
  });
});
