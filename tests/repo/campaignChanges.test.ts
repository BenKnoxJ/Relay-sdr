import { randomUUID } from "node:crypto";

import type { Job, Prisma } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { PackShape } from "../../agents/research/output.schema";
import { nameFrom, toResearchBrief, type ResearchBrief } from "@/lib/campaigns/brief";
import { deriveResearch } from "@/lib/campaigns/derive";
import { prisma } from "@/lib/db";
import { claimNext, complete, enqueue, fail } from "@/lib/jobs/queue";
import {
  CAMPAIGN_BRIEF_CHANGED,
  CAMPAIGN_RESEARCH_RETRIED,
  CampaignChangeRefused,
  createCampaign,
  editCampaignBrief,
  latestResearchJob,
  researchJobKey,
  retryResearch,
  widenCampaign,
  type ChangeRefusal,
} from "@/lib/repo/campaigns";
import { mutate } from "@/lib/repo/mutate";
import { recordResearchCompleted } from "@/lib/repo/research";
import { researchJobInputSchema as handlerInputSchema } from "@/worker/handlers/research";

import { emptyAll, resetDatabase } from "../db/harness";
import { briefFields, completePack, stoppedBrief, stoppedPack } from "../lib/campaignPacks";

/**
 * Widen, Edit brief and Try again (orchestrator amendment A1, items 4 to 6):
 * each is one transaction — the campaign, its Event and the research job, or
 * nothing — made from the version the rep saw, once, by the rep who owns it.
 * No research is run: results are written the way the research handler writes
 * them, through `recordResearchCompleted`.
 */

const ORG = "org_changes";
const OTHER_ORG = "org_changes_other";
const REP = "user_rep";
const COLLEAGUE = "user_colleague";
const STRANGER = "user_stranger";

beforeAll(async () => {
  await resetDatabase();
}, 120_000);

afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(async () => {
  await emptyAll();
  for (const id of [ORG, OTHER_ORG]) {
    await mutate(prisma, { orgId: id, actor: { kind: "system" }, kind: "org.created", apply: (tx) => tx.org.create({ data: { id, name: id } }) });
  }
  for (const [orgId, id] of [[ORG, REP], [ORG, COLLEAGUE], [OTHER_ORG, STRANGER]] as const) {
    await mutate(prisma, {
      orgId,
      actor: { kind: "system" },
      kind: "user.upserted",
      apply: (tx) => tx.user.create({ data: { id, orgId, email: `${id}@example.test` } }),
    });
  }
});

const C = () => stoppedBrief() as ResearchBrief;
const plain = () => toResearchBrief(briefFields());

async function startWith(brief: ResearchBrief) {
  const { campaign, job } = await createCampaign(prisma, {
    orgId: ORG,
    userId: REP,
    startRequestId: randomUUID(),
    name: nameFrom(brief.who),
    brief: brief as Prisma.InputJsonObject,
  });
  if (job === null) throw new Error("tests: a fresh start made no job");
  return { campaign, job };
}

/** Research finishing, as the research handler writes it. */
async function finish(job: Job, pack: PackShape, outcome: "complete" | "partial" | "insufficient") {
  const { event } = await recordResearchCompleted(prisma, {
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
  return event;
}

async function stopped(brief: ResearchBrief = C()) {
  const { campaign, job } = await startWith(brief);
  const event = await finish(job, stoppedPack(), "insufficient");
  return { campaign, job, event };
}

async function planReady() {
  const { campaign, job } = await startWith(plain());
  const event = await finish(job, completePack(), "complete");
  return { campaign, job, event };
}

async function failed(over: { attempts?: number; maxAttempts?: number } = {}) {
  const { campaign, job } = await startWith(plain());
  const failedJob = await prisma.job.update({
    where: { id: job.id },
    data: { status: "failed", error: "research: took_too_long — a rail was reached", attempts: over.attempts ?? 1, maxAttempts: over.maxAttempts ?? 3 },
  });
  return { campaign, job: failedJob };
}

const widen = (campaignId: string, optionIndex: number, over: { from?: number; requestId?: string; userId?: string; orgId?: string } = {}) =>
  widenCampaign(prisma, {
    orgId: over.orgId ?? ORG,
    userId: over.userId ?? REP,
    campaignId,
    fromBriefVersion: over.from ?? 1,
    optionIndex,
    requestId: over.requestId ?? randomUUID(),
  });

const edit = (campaignId: string, brief: ResearchBrief, over: { from?: number; requestId?: string; userId?: string; orgId?: string } = {}) =>
  editCampaignBrief(prisma, {
    orgId: over.orgId ?? ORG,
    userId: over.userId ?? REP,
    campaignId,
    fromBriefVersion: over.from ?? 1,
    brief,
    requestId: over.requestId ?? randomUUID(),
  });

const retry = (campaignId: string, over: { version?: number; requestId?: string; userId?: string; orgId?: string } = {}) =>
  retryResearch(prisma, {
    orgId: over.orgId ?? ORG,
    userId: over.userId ?? REP,
    campaignId,
    briefVersion: over.version ?? 1,
    requestId: over.requestId ?? randomUUID(),
  });

async function refusal(promise: Promise<unknown>): Promise<ChangeRefusal | "ok"> {
  try {
    await promise;
    return "ok";
  } catch (error) {
    if (error instanceof CampaignChangeRefused) return error.refusal;
    throw error;
  }
}

/** Everything a change could have written, to show a refused one wrote none of it. */
async function written(campaignId: string) {
  const campaign = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
  return {
    briefVersion: campaign.briefVersion,
    brief: campaign.brief,
    jobs: await prisma.job.count({ where: { campaignId } }),
    changes: await prisma.event.count({ where: { campaignId, kind: { in: [CAMPAIGN_BRIEF_CHANGED, CAMPAIGN_RESEARCH_RETRIED] } } }),
    statuses: (await prisma.job.findMany({ where: { campaignId }, orderBy: { createdAt: "asc" } })).map((job) => job.status),
  };
}

async function stateOf(campaignId: string) {
  const campaign = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
  const job = await latestResearchJob(prisma, campaign);
  const event =
    job === null ? null : await prisma.event.findFirst({ where: { orgId: ORG, kind: "research.completed", after: { path: ["jobId"], equals: job.id } } });
  return deriveResearch(job === null ? null : { status: job.status, error: job.error }, event === null ? null : { after: event.after }).state;
}

describe("widenCampaign", () => {
  it("@proof widens a stop by the chosen option: the next version, its scope, and research told why, in one transaction", async () => {
    const { campaign, job, event } = await stopped();
    const option = stoppedPack().insufficient!.widenings[0]!;

    const result = await widen(campaign.id, 0);

    expect(result.repeated).toBe(false);
    expect(result.campaign.briefVersion).toBe(2);
    // Option one: drop Orkney (`places: null`), keep Great Britain. The kinds of organisation are untouched.
    const widened = { ...C(), scope: { countries: ["GB"], orgTypes: ["veterinary practice"] } };
    expect(result.campaign.brief).toEqual(widened);

    const next = result.job!;
    expect(next).toMatchObject({ campaignId: campaign.id, briefVersion: 2, kind: "research", status: "queued", idempotencyKey: researchJobKey(campaign.id, 2) });
    expect(next.input).toEqual({
      brief: widened,
      priorPackIds: [event.id],
      priorRun: { insufficient: true, widenedBy: "region", note: option.text },
    });
    // The research handler reads it with its own schema.
    expect(handlerInputSchema.safeParse(next.input).success).toBe(true);

    const change = await prisma.event.findFirstOrThrow({ where: { kind: CAMPAIGN_BRIEF_CHANGED } });
    expect(change).toMatchObject({ orgId: ORG, campaignId: campaign.id, actorKind: "user", actorUserId: REP });
    expect(change.before).toEqual({ briefVersion: 1, brief: C() });
    expect(change.after).toMatchObject({
      briefVersion: 2,
      brief: widened,
      cause: "widening",
      widening: { optionIndex: 0, dimension: "region", text: option.text, scopePatch: { places: null, countries: ["GB"] } },
      priorPackIds: [event.id],
      jobId: next.id,
    });
    // The stop's job is left as it was, at its own version; the page now reads version 2.
    expect(await prisma.job.findUniqueOrThrow({ where: { id: job.id } })).toMatchObject({ status: "done", briefVersion: 1 });
    expect(await stateOf(campaign.id)).toBe("researching");
  });

  it("applies each of the stop's three real options as research wrote it", async () => {
    const options = stoppedPack().insufficient!.widenings;

    const second = await stopped();
    const two = await widen(second.campaign.id, 1);
    expect((two.campaign.brief as ResearchBrief).scope).toEqual({ ...C().scope, places: options[1]!.scopePatch.places, countries: ["GB"] });
    expect((two.job!.input as { priorRun: unknown }).priorRun).toEqual({ insufficient: true, widenedBy: "region", note: options[1]!.text });

    const third = await stopped();
    const three = await widen(third.campaign.id, 2);
    // `orgTypes: null` removes the constraint; Orkney stays.
    expect((three.campaign.brief as ResearchBrief).scope).toEqual({ countries: ["GB"], places: C().scope!.places });
    expect((three.job!.input as { priorRun: unknown }).priorRun).toEqual({ insufficient: true, widenedBy: "sector", note: options[2]!.text });
  });

  it("widens only a stop: never a plan, research still reading, or research that failed", async () => {
    const plan = await planReady();
    const reading = await startWith(C());
    const broken = await failed();
    for (const id of [plan.campaign.id, reading.campaign.id, broken.campaign.id]) {
      const before = await written(id);
      expect(await refusal(widen(id, 0))).toBe("wrong_state");
      expect(await written(id)).toEqual(before);
    }
  });

  it("refuses an option the stop did not offer", async () => {
    const { campaign } = await stopped();
    const before = await written(campaign.id);
    expect(await refusal(widen(campaign.id, 5))).toBe("bad_option");
    expect(await written(campaign.id)).toEqual(before);
  });

  it("checks the option against the brief as it stands, and refuses one that no longer widens it", async () => {
    // The same stop over a brief with no places set: "drop Orkney" removes
    // nothing, so it is no longer a widening, and choosing it is refused.
    const { scope, ...rest } = C();
    const { campaign } = await stopped({ ...rest, scope: { countries: scope!.countries, orgTypes: scope!.orgTypes } });
    const before = await written(campaign.id);

    expect(await refusal(widen(campaign.id, 0))).toBe("bad_option");
    expect(await written(campaign.id)).toEqual(before);
    // The sector option still widens it.
    expect(await refusal(widen(campaign.id, 2))).toBe("ok");
  });

  it("@proof refuses a version ahead of the campaign's and one behind it, writing nothing", async () => {
    const { campaign } = await stopped();
    const before = await written(campaign.id);
    expect(await refusal(widen(campaign.id, 0, { from: 2 }))).toBe("version_ahead");
    expect(await written(campaign.id)).toEqual(before);

    await widen(campaign.id, 0);
    const after = await written(campaign.id);
    expect(await refusal(widen(campaign.id, 1, { from: 1 }))).toBe("version_behind");
    expect(await written(campaign.id)).toEqual(after);
  });

  it("@proof lets exactly one of two different choices from the same version win", async () => {
    const { campaign } = await stopped();

    const results = await Promise.allSettled([widen(campaign.id, 0), widen(campaign.id, 2)]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const lost = results.find((result) => result.status === "rejected") as PromiseRejectedResult;
    expect(lost.reason).toBeInstanceOf(CampaignChangeRefused);
    expect((lost.reason as CampaignChangeRefused).refusal).toBe("version_behind");
    expect(await written(campaign.id)).toMatchObject({ briefVersion: 2, jobs: 2, changes: 1 });
  });

  it("@proof answers a repeated press with the change it already made, at once or later", async () => {
    const { campaign } = await stopped();
    const requestId = randomUUID();

    const [a, b] = await Promise.all([widen(campaign.id, 1, { requestId }), widen(campaign.id, 1, { requestId })]);
    expect([a.repeated, b.repeated].sort()).toEqual([false, true]);
    const later = await widen(campaign.id, 1, { requestId });
    expect(later).toMatchObject({ repeated: true, job: null, campaign: { briefVersion: 2 } });

    expect(await written(campaign.id)).toMatchObject({ briefVersion: 2, jobs: 2, changes: 1 });
  });

  it("refuses a request id reused for a different option", async () => {
    const { campaign } = await stopped();
    const requestId = randomUUID();
    await widen(campaign.id, 0, { requestId });
    expect(await refusal(widen(campaign.id, 2, { requestId }))).toBe("request_reused");
  });

  it("@proof lets no other rep and no other org widen the campaign", async () => {
    const { campaign } = await stopped();
    const before = await written(campaign.id);
    expect(await refusal(widen(campaign.id, 0, { userId: COLLEAGUE }))).toBe("not_found");
    expect(await refusal(widen(campaign.id, 0, { userId: STRANGER, orgId: OTHER_ORG }))).toBe("not_found");
    // A caller naming the right org with the wrong user, or the reverse, is no closer.
    expect(await refusal(widen(campaign.id, 0, { orgId: OTHER_ORG }))).toBe("not_found");
    expect(await written(campaign.id)).toEqual(before);
  });

  it("@proof leaves the queue refusing research for a brief version the campaign has moved on from", async () => {
    const { campaign } = await stopped();
    await widen(campaign.id, 0);

    await expect(
      enqueue(prisma, { orgId: ORG, kind: "research", idempotencyKey: "stale", input: {}, campaignId: campaign.id, briefVersion: 1 }),
    ).rejects.toThrow("behind the campaign's own");
    expect(await prisma.job.count({ where: { campaignId: campaign.id } })).toBe(2);
  });
});

describe("editCampaignBrief", () => {
  const changed = () => toResearchBrief(briefFields({ howMany: 30, channels: ["email", "linkedin"] }));

  it("@proof makes the rep's own fields the next version, and research reads the plan it replaces, with no priorRun", async () => {
    const { campaign, event } = await planReady();

    const result = await edit(campaign.id, changed());

    expect(result.campaign).toMatchObject({ briefVersion: 2, brief: changed() });
    expect(result.job).toMatchObject({ briefVersion: 2, idempotencyKey: researchJobKey(campaign.id, 2), status: "queued" });
    expect(result.job!.input).toEqual({ brief: changed(), priorPackIds: [event.id] });
    expect(result.job!.input).not.toHaveProperty("priorRun");
    expect(handlerInputSchema.safeParse(result.job!.input).success).toBe(true);

    const change = await prisma.event.findFirstOrThrow({ where: { kind: CAMPAIGN_BRIEF_CHANGED } });
    expect(change).toMatchObject({ campaignId: campaign.id, actorUserId: REP });
    expect(change.before).toEqual({ briefVersion: 1, brief: plain() });
    expect(change.after).toMatchObject({ briefVersion: 2, brief: changed(), cause: "edit", priorPackIds: [event.id], jobId: result.job!.id });
    expect(await stateOf(campaign.id)).toBe("researching");
  });

  it("from a stop, research reads the stop", async () => {
    const { campaign, event } = await stopped();
    const brief = { ...C(), howMany: 20 };
    const result = await edit(campaign.id, brief);
    expect(result.job!.input).toEqual({ brief, priorPackIds: [event.id] });
  });

  it("from needs you, reads the latest pack of any version, and none when there never was one", async () => {
    const never = await failed();
    const first = await edit(never.campaign.id, changed());
    expect(first.job!.input).toEqual({ brief: changed() });

    // Plan ready at v1, edited to v2, and v2's research failed: the v1 plan is still the latest pack.
    const { campaign, event } = await planReady();
    const v2 = await edit(campaign.id, changed());
    await prisma.job.update({ where: { id: v2.job!.id }, data: { status: "failed", error: "research: bad_output — x" } });
    const v3 = await edit(campaign.id, toResearchBrief(briefFields({ howMany: 50 })), { from: 2 });
    expect(v3.job!.input).toMatchObject({ priorPackIds: [event.id] });
  });

  it("refuses while research is still reading, and a brief with nothing changed", async () => {
    const reading = await startWith(plain());
    const before = await written(reading.campaign.id);
    expect(await refusal(edit(reading.campaign.id, changed()))).toBe("wrong_state");
    expect(await written(reading.campaign.id)).toEqual(before);

    const { campaign } = await planReady();
    // The same brief, its keys in another order.
    const same = JSON.parse(JSON.stringify(plain(), Object.keys(plain()).reverse())) as ResearchBrief;
    expect(await refusal(edit(campaign.id, same))).toBe("unchanged");
  });

  it("@proof lets one of two edits from the same version win, and answers a repeat with the edit it made", async () => {
    const { campaign } = await planReady();
    const results = await Promise.allSettled([edit(campaign.id, changed()), edit(campaign.id, toResearchBrief(briefFields({ howMany: 50 })))]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(await written(campaign.id)).toMatchObject({ briefVersion: 2, jobs: 2, changes: 1 });

    const other = await planReady();
    const requestId = randomUUID();
    const [a, b] = await Promise.all([edit(other.campaign.id, changed(), { requestId }), edit(other.campaign.id, changed(), { requestId })]);
    expect([a.repeated, b.repeated].sort()).toEqual([false, true]);
    expect(await refusal(edit(other.campaign.id, toResearchBrief(briefFields({ howMany: 50 })), { requestId }))).toBe("request_reused");
    expect(await written(other.campaign.id)).toMatchObject({ briefVersion: 2, jobs: 2, changes: 1 });
  });

  it("refuses a stale version and another rep's or org's campaign", async () => {
    const { campaign } = await planReady();
    await edit(campaign.id, changed());
    expect(await refusal(edit(campaign.id, plain(), { from: 1 }))).toBe("version_behind");
    expect(await refusal(edit(campaign.id, plain(), { from: 3 }))).toBe("version_ahead");
    expect(await refusal(edit(campaign.id, plain(), { from: 2, userId: COLLEAGUE }))).toBe("not_found");
    expect(await refusal(edit(campaign.id, plain(), { from: 2, userId: STRANGER, orgId: OTHER_ORG }))).toBe("not_found");
    expect(await written(campaign.id)).toMatchObject({ briefVersion: 2, jobs: 2, changes: 1 });
  });
});

describe("retryResearch", () => {
  it("@proof puts the failed job back on the queue: the same row, key, input and version, and one Event", async () => {
    const { campaign, job } = await failed();

    const result = await retry(campaign.id);

    expect(result.repeated).toBe(false);
    expect(result.job).toMatchObject({
      id: job.id,
      idempotencyKey: job.idempotencyKey,
      briefVersion: 1,
      status: "queued",
      // The attempt count carries on: the next claim is attempt 2, inside the allowance it had.
      attempts: 1,
      maxAttempts: 3,
    });
    expect(result.job!.input).toEqual(job.input);
    expect(result.campaign.briefVersion).toBe(1);
    expect(await prisma.job.count({ where: { campaignId: campaign.id } })).toBe(1);

    const event = await prisma.event.findFirstOrThrow({ where: { kind: CAMPAIGN_RESEARCH_RETRIED } });
    expect(event).toMatchObject({ campaignId: campaign.id, actorUserId: REP });
    expect(event.before).toEqual({ briefVersion: 1, jobId: job.id, status: "failed", attempts: 1, maxAttempts: 3, failure: "took_too_long" });
    expect(event.after).toMatchObject({ briefVersion: 1, jobId: job.id, status: "queued", attempts: 1, maxAttempts: 3 });
    expect(await stateOf(campaign.id)).toBe("researching");

    // And the worker takes it as the next attempt.
    expect(await claimNext(prisma, "worker-a")).toMatchObject({ id: job.id, attempts: 2 });
  });

  it("gives a job that spent every attempt one more, and a zombie write from an earlier attempt still lands nowhere", async () => {
    const { campaign, job } = await startWith(plain());
    await prisma.job.update({ where: { id: job.id }, data: { maxAttempts: 1 } });
    const first = await claimNext(prisma, "worker-a");
    await fail(prisma, first!, "research: took_too_long — x");

    const result = await retry(campaign.id);
    expect(result.job).toMatchObject({ status: "queued", attempts: 1, maxAttempts: 2 });

    const second = await claimNext(prisma, "worker-a");
    expect(second?.attempts).toBe(2);
    expect(await complete(prisma, first!)).toEqual({ ok: false, fenced: true });
    expect(await complete(prisma, second!)).toEqual({ ok: true, fenced: false });
  });

  it("@proof is one retry however often it is pressed, and a second rep's press after it is refused", async () => {
    const { campaign } = await failed();
    const requestId = randomUUID();

    const [a, b] = await Promise.all([retry(campaign.id, { requestId }), retry(campaign.id, { requestId })]);
    expect([a.repeated, b.repeated].sort()).toEqual([false, true]);
    expect(await retry(campaign.id, { requestId })).toMatchObject({ repeated: true, job: null });
    // A different press, once the job is back on the queue, is refused: there is nothing failed to retry.
    expect(await refusal(retry(campaign.id))).toBe("wrong_state");
    expect(await prisma.event.count({ where: { kind: CAMPAIGN_RESEARCH_RETRIED } })).toBe(1);
  });

  it("retries only research that failed: not a plan, a stop, research still reading, or a result it could not read", async () => {
    const plan = await planReady();
    const stop = await stopped();
    const reading = await startWith(plain());
    const unreadable = await startWith(plain());
    await prisma.job.update({ where: { id: unreadable.job.id }, data: { status: "done" } });
    for (const id of [plan.campaign.id, stop.campaign.id, reading.campaign.id, unreadable.campaign.id]) {
      const before = await written(id);
      expect(await refusal(retry(id))).toBe("wrong_state");
      expect(await written(id)).toEqual(before);
    }
  });

  it("refuses a stale or future version, and another rep's or org's campaign", async () => {
    const { campaign, job } = await failed();
    expect(await refusal(retry(campaign.id, { version: 2 }))).toBe("version_ahead");
    expect(await refusal(retry(campaign.id, { userId: COLLEAGUE }))).toBe("not_found");
    expect(await refusal(retry(campaign.id, { userId: STRANGER, orgId: OTHER_ORG }))).toBe("not_found");

    // Edited from needs you: version 2 is reading, and a retry of version 1 is behind it.
    await edit(campaign.id, toResearchBrief(briefFields({ howMany: 30 })));
    expect(await refusal(retry(campaign.id, { version: 1 }))).toBe("version_behind");
    expect(await prisma.job.findUniqueOrThrow({ where: { id: job.id } })).toMatchObject({ status: "failed" });
  });
});
