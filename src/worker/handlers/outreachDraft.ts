import { readFileSync } from "node:fs";
import path from "node:path";

import type { LanguageModel } from "ai";
import { z } from "zod";

import type { OutreachInput } from "../../../agents/outreach/input.schema";
import type { OutreachOutput } from "../../../agents/outreach/output.schema";
import type { ProductFacts } from "../../../agents/research/input.schema";
import { loadDefinition } from "@/lib/agents/definitions";
import type { RunModel } from "@/lib/agents/model";
import type { PricedModel } from "@/lib/agents/pricing";
import { makeModel } from "@/lib/agents/provider";
import { AgentRunFailedError, runAgent } from "@/lib/agents/run";
import { stubModel } from "@/lib/agents/stubModel";
import { storedPack } from "@/lib/campaigns/derive";
import { env } from "@/lib/env";
import { loadFacts } from "@/lib/facts/load";
import { buildOutreachInput, buyerRoleOf, liveFacts, packSliceOf, previewFields, relevanceTerms } from "@/lib/outreach/adapter";
import { gateEmail1, type Finding } from "@/lib/outreach/gates";
import { lookupEvidence, type LookupTrail } from "@/lib/outreach/lookup";
import { loadStandard } from "@/lib/outreach/standard";
import { latestResearchJob } from "@/lib/repo/campaigns";
import { findConfirmEvent, handoffOf } from "@/lib/repo/leadgen";
import {
  CAMPAIGN_DRAFT_COST_CAP_USD,
  campaignDraftCost,
  cohortFor,
  draftJobInputSchema,
  findDraftForJob,
  findLookup,
  recordDraft,
  recordLookup,
  voiceFor,
} from "@/lib/repo/outreach";
import { findResearchCompletedForJob } from "@/lib/repo/research";
import { createFirecrawlService, createTavilyService, type FetchService, type SearchService } from "@/lib/services";
import { TerminalError, safeError } from "@/worker/errors";
import type { Handler } from "@/worker/handlers/index";

/**
 * The `outreach_draft` job (outreach v2 §2–§8, as amended by v2.1): one first
 * email for one kept person with a usable email.
 *
 *   1. the person must still be a kept, revealed or known person of this
 *      campaign version, with a work email;
 *   2. the lookup runs once, code before the model, person then account, and
 *      stops at the first usable, relevant item (v2.1 §3); its result is an
 *      Event, so a retried job reads it back and searches for nothing;
 *   3. one model generation; the gates; at most one corrective redraft with
 *      the findings; then the draft is written as to review, or as Needs you
 *      with the labels, or as not written when neither generation came back in
 *      shape (v2.1 §6);
 *   4. the draft and its Event are written once.
 *
 * Nothing is sent.
 */

/** The facts file outreach claims from: the one research reads. */
const FACTS_PRODUCT = "insights360";
const FACTS_VERSION = 2;
/** At most two model generations per draft (v2.1 §6). */
export const MAX_GENERATIONS = 2;

export type OutreachHandlerDeps = {
  /** The model for one generation. Tests and the fixture walk-through hand in a scripted one. */
  makeModel: (id: PricedModel, input: OutreachInput, at: { attempt: number; generation: number }) => RunModel | LanguageModel;
  search: SearchService;
  fetch: FetchService;
  facts?: ProductFacts;
  now?: () => Date;
};

const fixtureDraftSchema = z.object({
  subject: z.string().optional(),
  body: z.string(),
  ask: z.string(),
  opener: z.object({ ref: z.string(), kind: z.string() }),
  claims: z.array(z.string()).default([]),
});
const fixtureDraftsSchema = z.object({ drafts: z.record(z.array(fixtureDraftSchema).min(1)) });

/**
 * The scripted writer for walking the review workflow with no model: each
 * generation takes the person's scripted draft for that generation, under
 * `<email>` for the first attempt and `<email>#<attempt>` for a draft the rep
 * asked for again. `$lookup` stands for the lookup item the job actually
 * found. Local and test only (`env.ts`).
 */
export function fixtureWriter(file: string): OutreachHandlerDeps["makeModel"] {
  const scripted = fixtureDraftsSchema.parse(JSON.parse(readFileSync(file, "utf8")));
  return (id, input, at) => {
    const email = input.person.email.toLowerCase();
    const list = scripted.drafts[`${email}#${at.attempt}`] ?? scripted.drafts[email];
    if (list === undefined) throw new TerminalError("outreach: no scripted draft for this person");
    const draft = list[Math.min(at.generation, list.length - 1)]!;
    const ref = draft.opener.ref === "$lookup" ? (input.lookup.items[0]?.id ?? "missing") : draft.opener.ref;
    const answer = { kind: "message", ...draft, opener: { ...draft.opener, ref } };
    return { transport: "stub", model: stubModel({ modelId: id, calls: [{ text: JSON.stringify(answer), usage: { in: 6000, out: 350, cacheRead: 0, cacheWrite: 0, reasoning: 0 } }], whenExhausted: "throw" }) };
  };
}

export function defaultOutreachDeps(): OutreachHandlerDeps {
  const e = env();
  const root = process.cwd();
  const mode = e.INTEGRATIONS === "live" ? (e.RELAY_TOOL_RECORD === "1" ? "record" : "live") : "mock";
  const fixturesDir = e.RELAY_OUTREACH_FIXTURES ?? path.join(root, "fixtures", "tools", "outreach");
  return {
    makeModel: e.RELAY_OUTREACH_FIXTURE_DRAFTS !== undefined ? fixtureWriter(e.RELAY_OUTREACH_FIXTURE_DRAFTS) : (id) => makeModel(id),
    search: createTavilyService(e, { mode, fixturesDir }),
    fetch: createFirecrawlService(e, { mode, fixturesDir }),
  };
}

type Generation = { output: OutreachOutput | null; tierA: Finding[]; tierB: Finding[]; costUsd: number };

/** The opener as the card shows it: the item's words, where they came from, and when. */
export function resolveOpener(
  opener: { ref: string; kind: string },
  lookup: OutreachInput["lookup"],
  slice: OutreachInput["pack"],
  buyerRole: OutreachInput["buyerRole"],
): { ref: string; kind: string; text: string; source: string; date: string } {
  const kind = opener.kind === "archetype_pain" ? "role_pain" : opener.kind;
  const item = lookup.items.find((candidate) => candidate.id === opener.ref);
  if ((kind === "person_fact" || kind === "firm_fact") && item !== undefined) {
    return { ref: opener.ref, kind, text: item.quote ?? item.text, source: item.evidence.domains[0] ?? "", date: item.publishedAt ?? "" };
  }
  const pain = slice.archetype.pains.find((candidate) => candidate.id === opener.ref);
  const text = pain?.text ?? (slice.hook?.id === opener.ref ? slice.hook.text : buyerRole?.id === opener.ref ? buyerRole.needs : "");
  return { ref: opener.ref, kind: "role_pain", text, source: "The campaign plan", date: "" };
}

export function outreachDraftHandler(deps: OutreachHandlerDeps = defaultOutreachDeps()): Handler {
  return async ({ db, job, signal }) => {
    const parsed = draftJobInputSchema.safeParse(job.input);
    if (!parsed.success) throw new TerminalError("outreach: bad input");
    if (job.campaignId === null || job.briefVersion === null) throw new TerminalError("outreach: bad input (no campaign)");
    const input = parsed.data;
    const scope = { orgId: job.orgId, campaignId: job.campaignId, briefVersion: job.briefVersion };

    const done = await findDraftForJob(db, { orgId: job.orgId, jobId: job.id });
    if (done !== null) return { draftId: done.id };

    const campaign = await db.campaign.findFirst({ where: { id: job.campaignId, orgId: job.orgId } });
    if (campaign === null) throw new TerminalError("outreach: no such campaign");
    const row = await db.campaignPerson.findFirst({
      where: { ...scope, id: input.campaignPersonId, status: "chosen", review: "kept", reveal: { in: ["revealed", "known"] } },
      include: { person: { select: { email: true } } },
    });
    if (row === null || row.person === null) throw new TerminalError("outreach: not a kept person with a usable email");
    const ownerUserId = job.ownerUserId ?? campaign.ownerUserId;
    const recordFor = { orgId: job.orgId, job: { id: job.id, campaignId: job.campaignId, briefVersion: job.briefVersion, ownerUserId }, campaignPersonId: row.id, attempt: input.attempt };

    const confirm = await findConfirmEvent(db, scope);
    if (confirm === null) throw new TerminalError("outreach: this version was never confirmed");
    const handoff = handoffOf(confirm);
    const researchJob = await latestResearchJob(db, campaign);
    const researched = researchJob === null ? null : await findResearchCompletedForJob(db, { orgId: job.orgId, jobId: researchJob.id });
    const pack = researched === null ? null : storedPack(researched.after);
    if (pack === null) throw new TerminalError("outreach: no research plan to write from");

    const facts = liveFacts(deps.facts ?? loadFacts(FACTS_PRODUCT, FACTS_VERSION).facts);
    const noLookup = { items: [], usable: false, searches: 0, fetches: 0 };

    // §11: the campaign's drafting ceiling. Past it, nothing more is written.
    if ((await campaignDraftCost(db, { orgId: job.orgId, campaignId: job.campaignId })) >= CAMPAIGN_DRAFT_COST_CAP_USD) {
      const draft = await recordDraft(db, { ...recordFor, state: "failed", draft: null, findings: [{ rule: "cost-cap", text: "This campaign has reached its drafting limit." }], advice: [], lookup: noLookup, generations: 0, costUsd: 0 });
      return { draftId: draft.id };
    }

    const now = (deps.now ?? (() => new Date()))();
    const slice = packSliceOf(pack, handoff, facts);
    const buyerRole = buyerRoleOf(row, handoff);
    const preview = previewFields(row.preview);

    // The lookup, once per job (§4): a retried job reads the recorded result back.
    let lookup = await findLookup(db, { orgId: job.orgId, jobId: job.id });
    if (lookup === null) {
      const found = await lookupEvidence(
        {
          personName: preview.name,
          company: preview.company,
          ...(preview.domain === undefined ? {} : { domain: preview.domain }),
          region: handoff.targeting.countries[0] ?? "GB",
          relevance: relevanceTerms(slice, buyerRole),
          triggers: handoff.targeting.triggers,
        },
        { search: deps.search, fetch: deps.fetch, now: () => now },
      );
      const { trail, ...result } = found;
      lookup = result;
      await recordLookup(db, { orgId: job.orgId, campaignId: job.campaignId, jobId: job.id, lookup: result, trail: trail as LookupTrail });
    }

    const cohort = await cohortFor(db, { ...scope, excludeCampaignPersonId: row.id, companyKey: row.companyKey });
    const owner = await db.user.findFirst({ where: { id: ownerUserId, orgId: job.orgId }, select: { name: true, email: true } });
    const repName = owner?.name ?? owner?.email.split("@")[0] ?? "";
    const base = {
      row,
      email: row.person.email,
      handoff,
      pack,
      facts,
      voice: await voiceFor(db, { orgId: job.orgId, userId: ownerUserId }),
      standard: loadStandard(),
      lookup,
      recentDrafts: cohort.filter((entry) => entry.opening.trim() !== "" && entry.ask.trim() !== "").slice(0, 20).map((entry) => ({ opening: entry.opening, ask: entry.ask, ...(entry.subject === undefined ? {} : { subject: entry.subject }), sameAccount: entry.sameAccount })),
      now,
    };
    // A rep's "wrong angle" or "wrong fact" (§9): the new draft moves away from the rejected one.
    const repRedraft =
      input.avoid === undefined
        ? undefined
        : {
            findings: [input.avoid.reason === "wrong_angle" ? "The rep rejected the last draft as the wrong angle: write on a different problem from the plan." : "The rep rejected the last draft for a wrong fact: open on the role problem, not on that fact."],
            previous: { body: input.avoid.previousBody || "(none)", ask: "(none)" },
          };

    const definition = loadDefinition("outreach");
    const modelId = definition.model;
    if (modelId === null) throw new TerminalError("outreach: the definition names no model");

    const generations: Generation[] = [];
    for (let index = 0; index < MAX_GENERATIONS; index += 1) {
      const previous = generations.at(-1);
      const redraft =
        previous === undefined
          ? repRedraft
          : {
              findings: previous.tierA.map((finding) => finding.text).slice(0, 20),
              previous:
                previous.output !== null && previous.output.kind === "message"
                  ? { ...(previous.output.subject === undefined ? {} : { subject: previous.output.subject }), body: previous.output.body, ask: previous.output.ask }
                  : { body: "(the last answer did not come back in the right shape)", ask: "(none)" },
            };
      const generationInput = buildOutreachInput({ ...base, ...(redraft === undefined ? {} : { redraft }) });
      try {
        const result = await runAgent({
          definition,
          input: generationInput,
          ctx: { db, orgId: job.orgId, jobId: job.id, model: deps.makeModel(modelId, generationInput, { attempt: input.attempt, generation: index }), modelId, signal, scrub: safeError },
        });
        const gates = gateEmail1(result.object, generationInput, { productNames: [facts.product], repName, cohort });
        generations.push({ output: result.object, tierA: gates.tierA, tierB: gates.tierB, costUsd: Number(result.run.costTotal) });
        if (gates.tierA.length === 0) break;
      } catch (error) {
        if (!(error instanceof AgentRunFailedError)) throw error;
        // A lost lease is not a failed draft: let the queue retry the job.
        if (error.reason === "aborted") throw error;
        const run = error.runId === "" ? null : await db.agentRun.findFirst({ where: { id: error.runId, orgId: job.orgId }, select: { costTotal: true } });
        generations.push({ output: null, tierA: [{ rule: "shape", text: "The draft did not come back in the right shape." }], tierB: [], costUsd: Number(run?.costTotal ?? 0) });
      }
    }

    const costUsd = generations.reduce((total, generation) => total + generation.costUsd, 0);
    const last = generations.at(-1)!;
    const written = [...generations].reverse().find((generation) => generation.output !== null && generation.output.kind === "message");
    const passed = last.output !== null && last.tierA.length === 0;
    const chosen = passed ? last : written;
    const message = chosen?.output !== null && chosen?.output?.kind === "message" ? chosen.output : null;
    const draft = await recordDraft(db, {
      ...recordFor,
      state: passed ? "to_review" : message === null ? "failed" : "needs_you",
      draft:
        message === null
          ? null
          : { ...(message.subject === undefined ? {} : { subject: message.subject }), body: message.body, ask: message.ask, opener: resolveOpener(message.opener, lookup, slice, buyerRole), claims: message.claims },
      findings: passed ? [] : (chosen ?? last).tierA,
      advice: chosen?.tierB ?? [],
      lookup,
      generations: generations.length,
      costUsd,
    });
    return { draftId: draft.id };
  };
}

export const outreachDraft: Handler = (context) => outreachDraftHandler()(context);
