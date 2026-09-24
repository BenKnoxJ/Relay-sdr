import { readFileSync } from "node:fs";
import path from "node:path";

import type { LanguageModel } from "ai";
import { z } from "zod";

import { SEQUENCE, TOUCH_KINDS, type OutreachInput, type TouchKind } from "../../../agents/outreach/input.schema";
import { LIMITS, outputSchemaFor, type OutreachOutput } from "../../../agents/outreach/output.schema";
import {
  humanizeInputSchema,
  humanizeOutputSchema,
  proseOf,
  sequenceOutputSchema,
  touchesOf,
  withProse,
  type HumanizeInput,
  type HumanTouches,
  type SequenceOutput,
} from "../../../agents/outreach/sequence.schema";
import type { ProductFacts } from "../../../agents/research/input.schema";
import { agentsDir, loadDefinition, type AgentDefinition } from "@/lib/agents/definitions";
import type { RunModel } from "@/lib/agents/model";
import type { PricedModel } from "@/lib/agents/pricing";
import { makeModel } from "@/lib/agents/provider";
import { AgentRunFailedError, rejectedAnswerText, runAgent, validationIssues } from "@/lib/agents/run";
import { stubModel } from "@/lib/agents/stubModel";
import { storedPack } from "@/lib/campaigns/derive";
import { draftCopy } from "@/lib/copy/draft";
import { OUTREACH_PROSE_WORDS } from "@/lib/copy/plainWords";
import { env } from "@/lib/env";
import { loadFacts } from "@/lib/facts/load";
import { loadNeverSay } from "@/lib/facts/neverSay";
import { buildOutreachInput, buyerRoleOf, liveFacts, packSliceOf, previewFields, relevanceTerms, senderOf, withApprovedGives, withLookupEvidence } from "@/lib/outreach/adapter";
import { addedFacts, evidenceUsedIn, gateFor, humanizerLoss, normaliseClaims, proseText, withoutThreadSubject, type Finding, type GateContext } from "@/lib/outreach/gates";
import { lookupEvidence, type LookupTrail } from "@/lib/outreach/lookup";
import { changePct, mentionsProduct, proseString } from "@/lib/outreach/messageChecks";
import { loadStandard } from "@/lib/outreach/standard";
import { latestResearchJob } from "@/lib/repo/campaigns";
import { findConfirmEvent, handoffOf } from "@/lib/repo/leadgen";
import {
  PERSON_DRAFT_COST_CAP_USD,
  cohortFor,
  draftJobInputSchema,
  findDraftsForJob,
  findLookup,
  personDraftCost,
  recordDrafts,
  recordLookup,
  voiceFor,
  type TouchRecord,
} from "@/lib/repo/outreach";
import { findResearchCompletedForJob } from "@/lib/repo/research";
import { createFirecrawlService, createTavilyService, type FetchService, type SearchService } from "@/lib/services";
import { TerminalError, safeError } from "@/worker/errors";
import type { Handler } from "@/worker/handlers/index";

/**
 * The `outreach_draft` job (outreach v2 §2–§8, as amended by v2.1 and by P2 on
 * 21 Sep 2026). The first press drafts one person's whole sequence (three
 * emails, a LinkedIn note and two messages, a call script); a rep's redraft
 * writes one touch again.
 *
 *   1. the person must still be a kept, revealed or known person of this
 *      campaign version, with a work email, and under the per-person drafting
 *      ceiling (§11 as P2 set it); past it the touches are parked for the rep;
 *   2. the lookup runs once, code before the model, person then account, and
 *      stops at the first usable, relevant item (v2.1 §3); its result is an
 *      Event, so a retried job reads it back and searches for nothing;
 *   3. **a sequence** is one model call returning all seven touches, each in its
 *      own shape; each touch is checked against its own rules and gates (Email
 *      1 keeps `gateEmail1`); the touches that failed go back once, together, in
 *      one corrective call, and the ones that passed keep their first words;
 *      then one humanizer call edits the sequence, facts locked, and each
 *      humanized touch is gated again and kept only if it broke nothing the
 *      draft had not broken and added no number or name;
 *      **a single touch** is one generation offered that touch's shape only, the
 *      gates for its kind, and at most one corrective redraft (v2.1 §6), then
 *      the same humanizer pass on that one touch (messaging v2: every message
 *      goes through the humanizer);
 *   4. the drafts and their one Event are written once, together.
 *
 * Nothing is sent.
 */

/** The facts file outreach claims from: the one research reads. */
const FACTS_PRODUCT = "insights360";
const FACTS_VERSION = 2;
/** At most two model generations per draft (v2.1 §6). */
export const MAX_GENERATIONS = 2;

/**
 * The humanizer's own wall clock (M2, 23 Sep 2026).
 *
 * It shared the drafter's 300 seconds, and in the 22 Sep cohort that was not
 * enough twice: Nell's pass never ran ("refused: cap") so 7 of her touches
 * reached the rep unhumanized, and Blair's draft hit the same ceiling. The
 * pass is doing more work than a draft call — it reads a 649-line prompt, the
 * facts file and seven touches — so it gets a ceiling of its own rather than
 * borrowing one sized for a different job.
 */
export const HUMANIZER_MAX_SECONDS = 600;

/** One retry, for a pass that ran out of time or came back refused. */
export const HUMANIZER_ATTEMPTS = 2;

/**
 * The draft calls' own wall clocks (M2 fix 1, 23 Sep 2026), set here beside the humanizer's rather than
 * borrowed from the definition's one budget.
 *
 * The whole-sequence call now reads the evidence list and M2's rules as well as seven touch shapes, and in the
 * 23 Sep partial cohort it ran out at 300 seconds three times in three people: both of Avery's generations and
 * Emlyn's first; the third person's answer landed at 295. So it gets 600, like the humanizer. A single touch
 * is one shape and one answer, the job the definition's 300 was sized for, so it keeps that.
 */
export const DRAFT_MAX_SECONDS = { sequence: 600, touch: 300 } as const;

/**
 * A generation that ran out of time (M2 fix 1). It is not a draft in the wrong shape and is not recorded as
 * one: the rep, and the cohort report, see that the model never answered.
 */
export const TIMED_OUT: Finding = { rule: "timeout", text: "Writing this ran out of time before an answer came back. Ask for it again." };

/** What the one corrective call is told about a generation that timed out: nothing was wrong with any words, there were none. */
const TIMED_OUT_FIX = "The last answer ran out of time before it came back. Write it again, as briefly as the rules allow.";

const SHAPE: Finding = { rule: "shape", text: "The draft did not come back in the right shape." };

/** A generation the run refused: out of time, or out of shape with the reasons the redraft is told. */
function refusedGeneration(error: AgentRunFailedError): Generation {
  if (error.reason === "cap" && error.cap === "minutes") return { output: null, tierA: [TIMED_OUT], tierB: [], refused: { fixes: [TIMED_OUT_FIX] } };
  return { output: null, tierA: [SHAPE], tierB: [], refused: refusalOf(error) };
}

/** Why a humanizer pass came back with nothing, for the Event and the cohort report: a timeout says so in words. */
function humanizerError(outcome: { refused: true; error: AgentRunFailedError } | { refused: false; error: unknown }, seconds: number): string {
  if (!outcome.refused) return safeError(outcome.error);
  return outcome.error.reason === "cap" && outcome.error.cap === "minutes" ? `timed out at ${seconds} s` : `refused: ${outcome.error.reason}`;
}

/** A finding as the corrective call reads it: a timeout says nothing to fix, its `refused` fix says it instead. */
const modelFindingsOf = (tierA: readonly Finding[]) => tierA.filter((finding) => finding.rule !== TIMED_OUT.rule).map((finding) => finding.text);

/** Which call a model is made for: a draft generation or the humanizer pass. */
export type ModelCall = { attempt: number; generation: number; pass: "draft" | "humanize"; humanize?: HumanizeInput };

export type OutreachHandlerDeps = {
  /** The model for one call. Tests and the fixture walk-through hand in a scripted one. */
  makeModel: (id: PricedModel, input: OutreachInput, at: ModelCall) => RunModel | LanguageModel;
  search: SearchService;
  fetch: FetchService;
  facts?: ProductFacts;
  now?: () => Date;
  /** Tests only: shorter wall clocks, so a run that never answers can be waited out in seconds. */
  maxSeconds?: { sequence?: number; touch?: number; humanize?: number };
};

const fixtureDraftSchema = z.object({
  subject: z.string().optional(),
  body: z.string(),
  ask: z.string(),
  opener: z.object({ ref: z.string(), kind: z.string() }),
  claims: z.array(z.string()).default([]),
});
const fixtureDraftsSchema = z.object({
  drafts: z.record(z.array(fixtureDraftSchema).min(1)),
  /** The rest of the sequence, the same for everyone: every touch but Email 1, in its own shape. */
  touches: z.record(z.unknown()).optional(),
});

/**
 * The scripted writer for walking the review workflow with no model: each
 * generation takes the person's scripted first email for that generation, under
 * `<email>` for the first attempt and `<email>#<attempt>` for a draft the rep
 * asked for again. A sequence adds the file's shared `touches` for the rest.
 * `$lookup` stands for the lookup item the job actually found and `$role` for
 * the person's role problem. The humanizer pass hands the words back as they
 * were. Local and test only (`env.ts`).
 */
export function fixtureWriter(file: string): OutreachHandlerDeps["makeModel"] {
  const scripted = fixtureDraftsSchema.parse(JSON.parse(readFileSync(file, "utf8")));
  return (id, input, at) => {
    const reply = (answer: unknown) => ({
      transport: "stub" as const,
      model: stubModel({ modelId: id, calls: [{ text: JSON.stringify(answer), usage: { in: 6000, out: 350, cacheRead: 0, cacheWrite: 0, reasoning: 0 } }], whenExhausted: "throw" }),
    });
    if (at.pass === "humanize") return reply(at.humanize?.touches ?? {});
    const email = input.person.email.toLowerCase();
    const list = scripted.drafts[`${email}#${at.attempt}`] ?? scripted.drafts[email];
    if (list === undefined) throw new TerminalError("outreach: no scripted draft for this person");
    const resolve = (ref: string) => (ref === "$lookup" ? (input.lookup.items[0]?.id ?? "missing") : ref === "$role" ? (input.buyerRole?.id ?? input.pack.archetype.pains[0]?.id ?? "missing") : ref);
    const draft = list[Math.min(at.generation, list.length - 1)]!;
    const first = { kind: "message", ...draft, opener: { ...draft.opener, ref: resolve(draft.opener.ref) } };
    if (input.sequence === undefined) return reply(first);
    if (scripted.touches === undefined) throw new TerminalError("outreach: the scripted drafts have no sequence touches");
    const rest = Object.fromEntries(
      Object.entries(scripted.touches).map(([kind, value]) => {
        const touch = value as { opener: { ref: string; kind: string } };
        return [kind, { ...touch, opener: { ...touch.opener, ref: resolve(touch.opener.ref) } }];
      }),
    );
    return reply({ ...rest, email1: first });
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

let humanizerPrompt: string | null = null;

/** The humanizer's system prompt: the outreach overlay and the fleet humanizer vendored in full (`agents/outreach/humanizer.md`). */
function loadHumanizer(): string {
  humanizerPrompt ??= readFileSync(path.join(agentsDir(), "outreach", "humanizer.md"), "utf8").trim();
  return humanizerPrompt;
}

/**
 * `refused` is what the writer is told about an answer the run refused: the
 * rules it broke and the answer itself, so the redraft fixes that and keeps the
 * rest. Model-facing only; the card shows the plain shape finding, because the
 * words named here are the ones a rep never sees.
 */
type Generation = { output: OutreachOutput | null; tierA: Finding[]; tierB: Finding[]; refused?: Refusal };

type Refusal = { fixes: string[]; previous?: { subject?: string; body: string; ask: string } };

const refusedAnswerSchema = z.object({ subject: z.string().max(200).optional(), body: z.string().max(5000), ask: z.string().max(300) });

const refusedCallSchema = z.object({ talkingPoint: z.object({ openingLine: z.string(), oneQuestion: z.string(), listenFor: z.string() }).partial() });

/** Why the run refused an answer, as instructions for the one redraft. */
export function refusalOf(error: unknown): Refusal {
  const text = rejectedAnswerText(error);
  let answer: unknown = null;
  try {
    answer = text === null ? null : JSON.parse(text);
  } catch {
    answer = null;
  }
  return refusalFrom(answer, validationIssues(error));
}

/** Why an answer (a whole one, or one touch of a sequence) was refused, from the answer and its schema issues. */
export function refusalFrom(answer: unknown, issues: readonly string[]): Refusal {
  const fixes: string[] = [];
  let previous: Refusal["previous"];
  const parsed = refusedAnswerSchema.safeParse(answer);
  const call = parsed.success ? null : refusedCallSchema.safeParse(answer);
  let prose: string[] = [];
  if (parsed.success) {
    previous = { ...(parsed.data.subject === undefined ? {} : { subject: parsed.data.subject }), body: parsed.data.body, ask: parsed.data.ask };
    prose = [parsed.data.subject ?? "", parsed.data.body, parsed.data.ask];
  } else if (call?.success === true) {
    prose = Object.values(call.data.talkingPoint).filter((field) => field !== undefined);
  }
  // The rep-words rule, read off the whole answer with the list the schema
  // checks it against: the issue text is cut short and names no word.
  const all = new RegExp(OUTREACH_PROSE_WORDS.source, "gi");
  const used = [...new Set(prose.flatMap((field) => [...field.matchAll(all)].map((match) => match[0].toLowerCase())))];
  if (used.length > 0) {
    fixes.push(`These words are refused in ${parsed.success ? "an email" : "a talking point"}, even in their everyday sense: ${used.map((word) => `"${word}"`).join(", ")}. Say each another way.`);
  }
  for (const issue of issues) {
    // Named above when the answer could be read; otherwise the issue is all there is.
    if (used.length > 0 && /machine word in a rep-facing string/.test(issue)) continue;
    fixes.push(/banned dash/.test(issue) ? "No em dashes, and no en dash with a space beside it." : issue.slice(0, 300));
  }
  if (fixes.length === 0) fixes.push("Answer with one email in the message shape: subject, body, ask, opener and claims.");
  return { fixes: fixes.slice(0, 10), ...(previous === undefined ? {} : { previous }) };
}

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


/** A call script as the rep reads it, stored as the draft's body: labelled lines, the objections as pairs. */
export function callScriptText(point: Extract<OutreachOutput, { kind: "call" }>["talkingPoint"]): string {
  const copy = draftCopy.callScript;
  return [
    `${copy.open} ${point.openingLine}`,
    `${copy.ask} ${point.oneQuestion}`,
    // M2: the second call's own words, labelled, so the rep reads a different script the second time.
    ...(point.openingLine2 === undefined ? [] : [`${copy.open2} ${point.openingLine2}`]),
    ...(point.oneQuestion2 === undefined ? [] : [`${copy.ask2} ${point.oneQuestion2}`]),
    `${copy.listen} ${point.listenFor}`,
    ...(point.voicemail === undefined ? [] : [`${copy.voicemail} ${point.voicemail}`]),
    ...(point.objections ?? []).map((pair) => `${copy.ifTheySay} ${pair.objection}\n${copy.say} ${pair.answer}`),
  ].join("\n\n");
}

/**
 * A touch as it is stored. A message as written, except that the follow-up is
 * a reply in Email 1's thread and LinkedIn has no subject line, so neither
 * keeps one. A call script as labelled lines, its question as the ask.
 */
export function storedDraftOf(
  output: OutreachOutput,
  kind: TouchKind,
  lookup: OutreachInput["lookup"],
  slice: OutreachInput["pack"],
  buyerRole: OutreachInput["buyerRole"],
): NonNullable<TouchRecord["draft"]> {
  const opener = resolveOpener(output.opener, lookup, slice, buyerRole);
  if (output.kind === "call") return { body: callScriptText(output.talkingPoint), ask: output.talkingPoint.oneQuestion, opener, claims: output.claims };
  // M2: only Email 1 opens a thread. The follow-up and the last email are
  // replies in it, so neither carries a subject — six of six last emails in
  // the 22 Sep cohort started a new thread, three of them with a lower-case
  // company name, and a rep reading the inbox lost the conversation.
  const subject = kind === "email1" ? output.subject : undefined;
  return { ...(subject === undefined ? {} : { subject }), body: output.body, ask: output.ask, opener, claims: output.claims };
}

/** An earlier touch as a later one reads it. */
function threadEntryOf(kind: TouchKind, output: OutreachOutput): OutreachInput["thread"][number] {
  const ordinal = SEQUENCE.indexOf(kind) + 1;
  if (output.kind === "call") return { kind, ordinal, body: proseText(output).slice(0, 5000), fate: "drafted" };
  return { kind, ordinal, ...(output.subject === undefined ? {} : { subject: output.subject.slice(0, 200) }), body: output.body, fate: "drafted" };
}

/** A touch's limits in words, for the humanizer. */
function limitText(kind: TouchKind): string {
  if (kind === "call") return "opening line at most 25 words; voicemail at most 40 words; at most 3 objections";
  const limits = LIMITS[kind];
  const parts = [
    limits.minWords !== undefined && limits.maxWords !== undefined ? `${limits.minWords} to ${limits.maxWords} words` : limits.maxWords !== undefined ? `at most ${limits.maxWords} words` : "",
    limits.maxChars !== undefined ? `at most ${limits.maxChars} characters` : "",
    limits.shrinks === true ? "shorter than the email before it" : "",
    limits.noLink === true ? "no link" : "",
  ];
  return parts.filter((part) => part !== "").join("; ");
}

const sentencesOf = (text: string) => (text.match(/[^.?!]+[.?!]*/g) ?? []).map((sentence) => sentence.replace(/\s+/g, " ").trim()).filter((sentence) => sentence !== "");
const sameWords = (a: string | undefined, b: string | undefined) => (a ?? "").replace(/\s+/g, " ").trim() === (b ?? "").replace(/\s+/g, " ").trim();

/**
 * A humanized message that cut its product sentence, cut cleanly: the drafted sentences with some taken
 * out, not one reworded or added, the subject and the ask as drafted, and nothing left naming the product.
 * Only then are the drafted claims cleared; a heuristic over reworded text can miss a paraphrased pitch.
 */
export function isCleanCut(drafted: Extract<OutreachOutput, { kind: "message" }>, offered: Extract<OutreachOutput, { kind: "message" }>, product: string): boolean {
  if (!sameWords(drafted.subject, offered.subject) || !sameWords(drafted.ask, offered.ask)) return false;
  const left = new Map<string, number>();
  const before = sentencesOf(drafted.body);
  for (const sentence of before) left.set(sentence, (left.get(sentence) ?? 0) + 1);
  const after = sentencesOf(offered.body);
  for (const sentence of after) {
    const count = left.get(sentence) ?? 0;
    if (count === 0) return false;
    left.set(sentence, count - 1);
  }
  if (after.length >= before.length) return false;
  return !mentionsProduct({ kind: "message", body: offered.body, ask: offered.ask, claims: [], ...(offered.subject === undefined ? {} : { subject: offered.subject }) }, product);
}

/** The words a person has already been given at this version, for a redraft of a later touch: each earlier touch's latest draft. */
async function threadFor(
  db: Parameters<Handler>[0]["db"],
  where: { orgId: string; campaignId: string; briefVersion: number; campaignPersonId: string; before: TouchKind },
): Promise<OutreachInput["thread"]> {
  const earlier = SEQUENCE.slice(0, SEQUENCE.indexOf(where.before));
  if (earlier.length === 0) return [];
  const drafts = await db.outreachDraft.findMany({
    where: { orgId: where.orgId, campaignId: where.campaignId, briefVersion: where.briefVersion, campaignPersonId: where.campaignPersonId, touch: { in: earlier }, body: { not: null } },
    orderBy: [{ attempt: "asc" }, { createdAt: "asc" }],
  });
  const latest = new Map<string, (typeof drafts)[number]>();
  for (const draft of drafts) latest.set(draft.touch, draft);
  return earlier.flatMap((kind) => {
    const draft = latest.get(kind);
    if (draft === undefined) return [];
    return [{ kind, ordinal: SEQUENCE.indexOf(kind) + 1, ...(draft.subject === null ? {} : { subject: draft.subject.slice(0, 200) }), body: (draft.editedBody ?? draft.body ?? "").slice(0, 5000), fate: "drafted" as const }];
  });
}

type Outcome<T> = { ok: true; object: T } | { ok: false; refused: true; error: AgentRunFailedError } | { ok: false; refused: false; error: unknown };

type HumanizerTouchLog = {
  drafted: HumanTouches[keyof HumanTouches];
  humanized: HumanTouches[keyof HumanTouches] | null;
  kept: "humanized" | "drafted";
  reason?: string;
  /** The share of the touch's characters the humanizer changed, whether or not its version was kept; null when it returned nothing for the touch. */
  changePct: number | null;
  /** The humanizer said it cut the product sentence; `kept` says whether its version, without the claims, was used. */
  droppedProduct?: true;
};

type HumanizerLog = { ran: boolean; skipped?: string; error?: string; touches: Partial<Record<TouchKind, HumanizerTouchLog>> };

/** Tier B advice on a touch the humanizer never reached (M2, item 3). */
export const NOT_HUMANIZED: Finding = { rule: "not-humanized", text: "The humanizer did not run on this one, so these are the drafted words. Read it more closely than usual." };

function resultOf(drafts: { id: string }[]): { draftId: string; draftIds: string[] } {
  return { draftId: drafts[0]!.id, draftIds: drafts.map((draft) => draft.id) };
}

const isTouchKind = (value: string): value is TouchKind => (TOUCH_KINDS as readonly string[]).includes(value);

export function outreachDraftHandler(deps: OutreachHandlerDeps = defaultOutreachDeps()): Handler {
  return async ({ db, job, signal }) => {
    const parsed = draftJobInputSchema.safeParse(job.input);
    if (!parsed.success) throw new TerminalError("outreach: bad input");
    if (job.campaignId === null || job.briefVersion === null) throw new TerminalError("outreach: bad input (no campaign)");
    const input = parsed.data;
    const scope = { orgId: job.orgId, campaignId: job.campaignId, briefVersion: job.briefVersion };

    const done = await findDraftsForJob(db, { orgId: job.orgId, jobId: job.id });
    if (done.length > 0) return resultOf(done);

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

    // The first press drafts the whole sequence; a rep's redraft (or a job from before P2 that names no touch past attempt 1) writes one touch.
    const sequence = input.touch === undefined && input.attempt === 1 && input.avoid === undefined;
    const kinds: readonly TouchKind[] = sequence ? SEQUENCE : [input.touch ?? "email1"];
    const write = async (touches: TouchRecord[], lookupUsed: OutreachInput["lookup"], record?: Record<string, unknown>) =>
      resultOf(await recordDrafts(db, { ...recordFor, lookup: lookupUsed, touches, ...(record === undefined ? {} : { record }) }));
    /** Every touch this job owns, in one state with one finding: the job's cost on the first. */
    const every = (state: TouchRecord["state"], finding: Finding, costUsd = 0, generations = 0): TouchRecord[] =>
      kinds.map((touch, index) => ({ touch, state, draft: null, findings: [finding], advice: [], generations, costUsd: index === 0 ? costUsd : 0 }));

    // An error that is not a failed agent run goes back to the queue while attempts remain. When no
    // retry is coming (the error is terminal, or this is the last attempt) the person gets a visible
    // "could not be written" draft instead of silently dropping out of the campaign. A lost lease is
    // never a failed draft.
    const unexpected = (error: unknown): boolean => !signal.aborted && (error instanceof TerminalError || job.attempts >= job.maxAttempts);
    const unexpectedFinding: Finding = { rule: "error", text: "Something went wrong while writing this draft." };
    const capFinding: Finding = { rule: "cost-cap", text: "This person has reached their drafting limit, so Relay stopped here." };

    // §11 as P2 set it: a ceiling per person, across every touch and attempt at this version.
    // Past it nothing more is written, and the touches wait for the rep rather than failing.
    const prior = await personDraftCost(db, { ...scope, campaignPersonId: row.id });
    if (prior >= PERSON_DRAFT_COST_CAP_USD) return write(every("needs_you", capFinding), noLookup);

    const now = (deps.now ?? (() => new Date()))();
    const slice = packSliceOf(pack, handoff, facts);
    const buyerRole = buyerRoleOf(row, handoff);
    const preview = previewFields(row.preview);

    // The lookup, once per job (§4): a retried job reads the recorded result back.
    let lookup = await findLookup(db, { orgId: job.orgId, jobId: job.id });
    if (lookup === null) {
      let found: Awaited<ReturnType<typeof lookupEvidence>>;
      try {
        found = await lookupEvidence(
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
      } catch (error) {
        if (!unexpected(error)) throw error;
        return write(every("failed", unexpectedFinding), noLookup);
      }
      const { trail, ...result } = found;
      lookup = result;
      await recordLookup(db, { orgId: job.orgId, campaignId: job.campaignId, jobId: job.id, lookup: result, trail: trail as LookupTrail });
    }
    const lookupUsed = lookup;

    const cohort = await cohortFor(db, { ...scope, excludeCampaignPersonId: row.id, companyKey: row.companyKey });
    // The quotable sources behind this person's slice, read once: the recent drafts are scanned against them.
    const standard = loadStandard();
    const evidence = withApprovedGives(withLookupEvidence(slice, lookupUsed), standard).evidence;
    const owner = await db.user.findFirst({ where: { id: ownerUserId, orgId: job.orgId }, select: { name: true, email: true, org: { select: { name: true } } } });
    if (owner === null) throw new TerminalError("outreach: the campaign's owner is not in this org");
    const repName = owner.name ?? owner.email.split("@")[0] ?? "";
    const base = {
      row,
      email: row.person.email,
      sender: senderOf({ userName: owner.name, email: owner.email, orgName: owner.org.name }),
      handoff,
      pack,
      facts,
      voice: await voiceFor(db, { orgId: job.orgId, userId: ownerUserId }),
      standard,
      lookup: lookupUsed,
      // M2: what a colleague at the same firm has already been sent, and not
      // only their opening and ask — the angle they opened on and the source
      // they quoted, so the drafter can take a different one rather than
      // finding out from the gate that it took the same.
      recentDrafts: cohort
        .filter((entry) => entry.opening.trim() !== "" && entry.ask.trim() !== "")
        .slice(0, 20)
        .map((entry) => {
          const evidenceIds = entry.sameAccount ? evidenceUsedIn(entry.body, evidence) : [];
          return {
            opening: entry.opening,
            ask: entry.ask,
            ...(entry.subject === undefined ? {} : { subject: entry.subject }),
            sameAccount: entry.sameAccount,
            ...(isTouchKind(entry.touch) ? { touch: entry.touch } : {}),
            ...(entry.openerRef === undefined ? {} : { openerRef: entry.openerRef }),
            ...(evidenceIds.length === 0 ? {} : { evidenceIds: evidenceIds.slice(0, 6) }),
          };
        }),
      now,
    };
    // The facts file's never-say list: research has been linted against it since brief E, and outreach
    // writes to the same prospects about the same product, so it is held to the same list (M2).
    const context: GateContext = { productNames: [facts.product], repName, cohort, neverSay: loadNeverSay(FACTS_PRODUCT, FACTS_VERSION) };
    // A rep's "wrong angle" or "wrong fact" (§9): the new draft moves away from the rejected one.
    const repRedraft =
      input.avoid === undefined
        ? undefined
        : {
            findings: [input.avoid.reason === "wrong_angle" ? "The rep rejected the last draft as the wrong angle: write on a different problem from the plan." : "The rep rejected the last draft for a wrong fact: open on the role problem, not on that fact."],
            previous: { body: input.avoid.previousBody || "(none)", ask: "(none)" },
          };

    const signed = loadDefinition("outreach");
    const seconds = { sequence: DRAFT_MAX_SECONDS.sequence, touch: DRAFT_MAX_SECONDS.touch, humanize: HUMANIZER_MAX_SECONDS, ...deps.maxSeconds };
    const modelId = signed.model;
    if (modelId === null) throw new TerminalError("outreach: the definition names no model");

    // What this job has spent, split between the draft calls and the humanizer.
    const spent = { draft: 0, humanize: 0 };
    const total = () => spent.draft + spent.humanize;
    const capped = () => prior + total() >= PERSON_DRAFT_COST_CAP_USD;

    /** One model call, its cost counted whatever happens. A lost lease is rethrown: the queue retries the job. */
    async function call<IN, OUT>(definition: AgentDefinition<IN, OUT>, runInput: IN, modelInput: OutreachInput, at: ModelCall): Promise<Outcome<OUT>> {
      try {
        const result = await runAgent({
          definition,
          input: runInput,
          ctx: { db, orgId: job.orgId, jobId: job.id, model: deps.makeModel(modelId!, modelInput, at), modelId: modelId!, signal, scrub: safeError },
        });
        spent[at.pass] += Number(result.run.costTotal);
        return { ok: true, object: result.object };
      } catch (error) {
        if (!(error instanceof AgentRunFailedError)) return { ok: false, refused: false, error };
        if (error.reason === "aborted") throw error;
        const run = error.runId === "" ? null : await db.agentRun.findFirst({ where: { id: error.runId, orgId: job.orgId }, select: { costTotal: true } });
        spent[at.pass] += Number(run?.costTotal ?? 0);
        return { ok: false, refused: true, error };
      }
    }

    /** A touch's generations settled: to review, Needs you with the labels, or not written (v2.1 §6). */
    function settle(kind: TouchKind, generations: Generation[], stoppedByCap: boolean): { record: TouchRecord; output: OutreachOutput | null } {
      const shape = kind === "call" ? "call" : "message";
      const last = generations.at(-1)!;
      const written = [...generations].reverse().find((generation) => generation.output?.kind === shape);
      const passed = last.output !== null && last.tierA.length === 0;
      const chosen = passed ? last : written;
      const output = chosen?.output?.kind === shape ? chosen.output : null;
      const findings = passed ? [] : (chosen ?? last).tierA;
      const record: TouchRecord = {
        touch: kind,
        state: passed ? "to_review" : output === null ? "failed" : "needs_you",
        draft: output === null ? null : storedDraftOf(output, kind, lookupUsed, slice, buyerRole),
        findings,
        advice: chosen?.tierB ?? [],
        generations: generations.length,
        costUsd: 0,
      };
      // The ceiling stopped the corrective redraft: parked for the rep, never a dead end.
      if (stoppedByCap && !passed) Object.assign(record, { state: "needs_you", findings: [capFinding, ...findings] });
      return { record, output };
    }

    const redraftPrevious = (previous: Generation | undefined) =>
      previous?.output?.kind === "message"
        ? { ...(previous.output.subject === undefined ? {} : { subject: previous.output.subject }), body: previous.output.body, ask: previous.output.ask }
        : previous?.output?.kind === "call"
          ? { body: callScriptText(previous.output.talkingPoint), ask: previous.output.talkingPoint.oneQuestion }
          : (previous?.refused?.previous ?? { body: "(the last answer did not come back in the right shape)", ask: "(none)" });

    /**
     * The humanizer over the touches written so far: one call, facts locked, voice free. A touch's
     * humanized words are gated again (against `gateInputOf`) and kept only if they broke nothing the
     * draft had not broken and added no number or name. Rewrites `settled` in place; returns the log.
     */
    async function humanizePass(
      which: readonly TouchKind[],
      settled: Map<TouchKind, { record: TouchRecord; output: OutreachOutput | null }>,
      gateInputOf: (kind: TouchKind) => OutreachInput,
      modelInput: OutreachInput,
    ): Promise<HumanizerLog> {
      const candidates = which.filter((kind) => settled.get(kind)!.output !== null);
      const log: HumanizerLog = { ran: false, touches: {} };
      if (candidates.length === 0) return { ...log, skipped: "nothing written" };
      if (capped()) return { ...log, skipped: "cost-cap" };
      const humanizeInput: HumanizeInput = {
        firstName: modelInput.person.firstName,
        sender: modelInput.sender,
        rules: modelInput.standard.rules,
        facts: modelInput.facts,
        voice: modelInput.voice,
        bannedLexicon: modelInput.standard.bannedLexicon,
        touches: Object.fromEntries(candidates.map((kind) => [kind, proseOf(settled.get(kind)!.output!)])),
        limits: Object.fromEntries(candidates.map((kind) => [kind, limitText(kind)])),
      };
      const humanizerDefinition = {
        ...signed,
        prompt: loadHumanizer(),
        input: humanizeInputSchema,
        output: humanizeOutputSchema,
        budget: { ...signed.budget, maxSeconds: seconds.humanize },
      };
      // One retry. A pass that ran out of time or came back out of shape is
      // worth asking for again; the cost cap is the thing that stops it, and
      // it is re-checked before the second attempt like any other model call.
      let outcome = await call(humanizerDefinition, humanizeInput, modelInput, { attempt: input.attempt, generation: 0, pass: "humanize", humanize: humanizeInput });
      let firstError: string | undefined;
      for (let retry = 1; retry < HUMANIZER_ATTEMPTS && !outcome.ok; retry += 1) {
        firstError ??= humanizerError(outcome, seconds.humanize);
        if (capped()) break;
        outcome = await call(humanizerDefinition, humanizeInput, modelInput, { attempt: input.attempt, generation: retry, pass: "humanize", humanize: humanizeInput });
      }
      if (!outcome.ok) {
        // Nothing was humanized. The rep is told so on every touch, because a
        // touch that never went through the pass is not the same as one that
        // went through and came back unchanged, and only the rep can tell.
        const error = firstError ?? humanizerError(outcome, seconds.humanize);
        for (const kind of candidates) {
          const entry = settled.get(kind)!;
          settled.set(kind, { ...entry, record: { ...entry.record, advice: [...entry.record.advice, NOT_HUMANIZED] } });
        }
        return { ...log, error };
      }
      log.ran = true;
      for (const kind of SEQUENCE.filter((candidate) => candidates.includes(candidate))) {
        const entry = settled.get(kind)!;
        const drafted = entry.output!;
        const rewritten = withProse(drafted, outcome.object[kind]);
        const dropped = rewritten !== null && drafted.claims.length > 0 && rewritten.claims.length === 0;
        let reason: string | undefined;
        let accepted: { output: OutreachOutput; tierA: Finding[]; tierB: Finding[] } | undefined;
        const cleanProductCut = dropped && drafted.kind === "message" && rewritten !== null && rewritten.kind === "message" && isCleanCut(drafted, rewritten, modelInput.facts.product);
        if (rewritten === null) reason = "no humanized text came back for this touch";
        // "I cut the product sentence" clears the claims only when the cut is certain (`isCleanCut`);
        // otherwise the drafted touch stands, claims and all.
        else if (dropped && !cleanProductCut)
          reason = "said it cut the product sentence, but the words were reworded or still name the product: the drafted touch and its claims are kept";
        else {
          const shaped = outputSchemaFor(kind).safeParse(rewritten);
          const added = shaped.success ? addedFacts(drafted, shaped.data) : [];
          const lost = shaped.success ? humanizerLoss(drafted, shaped.data, modelInput.pack.evidence, cleanProductCut) : null;
          if (!shaped.success) reason = `out of shape: ${shaped.error.issues.map((issue) => issue.message).join("; ").slice(0, 300)}`;
          else if (added.length > 0) reason = `added what the draft did not say: ${added.join(", ")}`;
          else if (lost !== null) reason = `lost what the draft said: ${lost}`;
          else {
            const gateInput = gateInputOf(kind);
            const output = normaliseClaims(shaped.data, gateInput);
            const gates = gateFor(output, gateInput, context);
            const had = new Set(entry.record.findings.map((finding) => finding.rule));
            const broke = [...new Set(gates.tierA.map((finding) => finding.rule).filter((rule) => !had.has(rule)))];
            if (broke.length > 0) reason = `failed a check the draft passed: ${broke.join(", ")}`;
            else accepted = { output, tierA: gates.tierA, tierB: gates.tierB };
          }
        }
        log.touches[kind] = {
          drafted: proseOf(drafted),
          humanized: rewritten === null ? null : proseOf(rewritten),
          kept: accepted === undefined ? "drafted" : "humanized",
          ...(reason === undefined ? {} : { reason }),
          changePct: rewritten === null ? null : changePct(proseString(proseOf(drafted)), proseString(proseOf(rewritten))),
          ...(dropped ? { droppedProduct: true as const } : {}),
        };
        if (accepted === undefined) continue;
        const passed = accepted.tierA.length === 0;
        settled.set(kind, {
          output: accepted.output,
          record: {
            ...entry.record,
            state: passed ? "to_review" : "needs_you",
            draft: storedDraftOf(accepted.output, kind, lookupUsed, slice, buyerRole),
            findings: passed ? [] : accepted.tierA,
            advice: accepted.tierB,
          },
        });
      }
      return log;
    }

    // -------------------------------------------------------------------------
    // One touch: the rep asked for it again. One call, and at most one corrective redraft.
    if (!sequence) {
      const kind = kinds[0]!;
      const thread = await threadFor(db, { ...scope, campaignPersonId: row.id, before: kind });
      const generations: Generation[] = [];
      let stoppedByCap = false;
      for (let index = 0; index < MAX_GENERATIONS; index += 1) {
        if (index > 0 && capped()) {
          stoppedByCap = true;
          break;
        }
        const previous = generations.at(-1);
        const redraft =
          previous === undefined
            ? repRedraft
            : { findings: [...modelFindingsOf(previous.tierA), ...(previous.refused?.fixes ?? [])].slice(0, 20), previous: redraftPrevious(previous) };
        const generationInput = buildOutreachInput({ ...base, touch: kind, thread, ...(redraft === undefined ? {} : { redraft }) });
        const outcome = await call(
          { ...signed, output: outputSchemaFor(kind), budget: { ...signed.budget, maxSeconds: seconds.touch } },
          generationInput,
          generationInput,
          { attempt: input.attempt, generation: index, pass: "draft" },
        );
        if (outcome.ok) {
          const output = normaliseClaims(withoutThreadSubject(outcome.object, kind), generationInput);
          const gates = gateFor(output, generationInput, context);
          generations.push({ output, tierA: gates.tierA, tierB: gates.tierB });
          if (gates.tierA.length === 0) break;
        } else if (!outcome.refused) {
          if (!unexpected(outcome.error)) throw outcome.error;
          return write(every("failed", unexpectedFinding, total(), generations.length), lookupUsed);
        } else {
          generations.push(refusedGeneration(outcome.error));
        }
      }
      const settledOne = new Map([[kind, settle(kind, generations, stoppedByCap)]]);
      const gateInput = () => buildOutreachInput({ ...base, touch: kind, thread });
      const humanizer = await humanizePass([kind], settledOne, gateInput, gateInput());
      const { record } = settledOne.get(kind)!;
      return write([{ ...record, costUsd: total() }], lookupUsed, { cost: { draftUsd: round(spent.draft), humanizerUsd: round(spent.humanize) }, humanizer });
    }

    // -------------------------------------------------------------------------
    // The sequence: one call for all seven touches, then the gates per touch.
    const draftInput = buildOutreachInput({ ...base, sequence: true });
    const sequenceDefinition = { ...signed, output: sequenceOutputSchema, budget: { ...signed.budget, maxSeconds: seconds.sequence } };
    const history = new Map<TouchKind, Generation[]>(kinds.map((kind) => [kind, []]));
    const latest = (kind: TouchKind) => [...history.get(kind)!].reverse().find((generation) => generation.output !== null)?.output ?? null;
    const threadOf = (kind: TouchKind, outputOf: (kind: TouchKind) => OutreachOutput | null) =>
      SEQUENCE.slice(0, SEQUENCE.indexOf(kind)).flatMap((earlier) => {
        const output = outputOf(earlier);
        return output === null ? [] : [threadEntryOf(earlier, output)];
      });
    const touchInput = (kind: TouchKind, outputOf: (kind: TouchKind) => OutreachOutput | null) => buildOutreachInput({ ...base, touch: kind, thread: threadOf(kind, outputOf) });

    /** An answer's touches onto their histories, then each gated against the earlier touches as they now stand. */
    function take(outcome: Outcome<SequenceOutput>, which: readonly TouchKind[]): void {
      if (!outcome.ok) {
        for (const kind of which) history.get(kind)!.push(outcome.refused ? refusedGeneration(outcome.error) : { output: null, tierA: [SHAPE], tierB: [] });
        return;
      }
      const parsedTouches = touchesOf(outcome.object);
      for (const kind of which) {
        const touch = parsedTouches.find((candidate) => candidate.kind === kind)!;
        history
          .get(kind)!
          .push(
            touch.output === null
              ? { output: null, tierA: [SHAPE], tierB: [], refused: refusalFrom(outcome.object[kind], touch.issues) }
              : { output: normaliseClaims(withoutThreadSubject(touch.output, kind), draftInput), tierA: [], tierB: [] },
          );
      }
      for (const kind of SEQUENCE.filter((candidate) => which.includes(candidate))) {
        const generation = history.get(kind)!.at(-1)!;
        if (generation.output === null) continue;
        const gates = gateFor(generation.output, touchInput(kind, latest), context);
        generation.tierA = gates.tierA;
        generation.tierB = gates.tierB;
      }
    }

    const first = await call(sequenceDefinition, draftInput, draftInput, { attempt: input.attempt, generation: 0, pass: "draft" });
    if (!first.ok && !first.refused) {
      if (!unexpected(first.error)) throw first.error;
      return write(every("failed", unexpectedFinding, total()), lookupUsed);
    }
    take(first, kinds);

    // One corrective call for the touches that failed, together. The ones that passed keep their words.
    const failing = kinds.filter((kind) => history.get(kind)!.at(-1)!.tierA.length > 0);
    const stoppedByCap = failing.length > 0 && capped();
    let redraftError: string | undefined;
    if (failing.length > 0 && !stoppedByCap) {
      const findings = failing
        .flatMap((kind) => {
          const last = history.get(kind)!.at(-1)!;
          return [...modelFindingsOf(last.tierA), ...(last.refused?.fixes ?? [])].map((finding) => `${kind}: ${finding}`);
        })
        .map((finding) => finding.slice(0, 500))
        .slice(0, 20);
      const previousTouches = SEQUENCE.flatMap((kind) => {
        const output = latest(kind);
        return output === null ? [] : [threadEntryOf(kind, output)];
      });
      const firstEmail = history.get("email1")!.at(-1);
      const redraft = { findings, previous: redraftPrevious(firstEmail), ...(previousTouches.length === 0 ? {} : { previousTouches }) };
      const redraftInput = buildOutreachInput({ ...base, sequence: true, redraft });
      const second = await call(sequenceDefinition, redraftInput, redraftInput, { attempt: input.attempt, generation: 1, pass: "draft" });
      // An unexpected failure here keeps the first answer: a retry would pay for the whole sequence again.
      if (!second.ok && !second.refused) redraftError = safeError(second.error);
      else take(second, failing);
    }

    const settled = new Map(kinds.map((kind) => [kind, settle(kind, history.get(kind)!, stoppedByCap)]));

    // The humanizer: subtractive, facts locked, voice free. Each touch it edits is gated again.
    const keptOf = (kind: TouchKind) => settled.get(kind)?.output ?? null;
    const humanizer = await humanizePass(kinds, settled, (kind) => touchInput(kind, keptOf), draftInput);

    // The last word: every touch gated once more against the sequence as it now stands. A corrective call or the
    // humanizer can change an earlier email, and "shorter than the last" must hold against the email actually kept.
    const finalOf = (kind: TouchKind) => settled.get(kind)?.output ?? null;
    for (const kind of SEQUENCE.filter((candidate) => kinds.includes(candidate))) {
      const entry = settled.get(kind)!;
      if (entry.output === null) continue;
      const gates = gateFor(entry.output, touchInput(kind, finalOf), context);
      const cap = entry.record.findings.some((finding) => finding.rule === capFinding.rule) ? [capFinding] : [];
      const passed = gates.tierA.length === 0 && cap.length === 0;
      settled.set(kind, { ...entry, record: { ...entry.record, state: passed ? "to_review" : "needs_you", findings: passed ? [] : [...cap, ...gates.tierA], advice: gates.tierB } });
    }

    // The job's cost sits on its first touch, so a person's drafts add up to what the job spent.
    const records = kinds.map((kind, index) => ({ ...settled.get(kind)!.record, costUsd: index === 0 ? total() : 0 }));
    return write(records, lookupUsed, {
      cost: { draftUsd: round(spent.draft), humanizerUsd: round(spent.humanize) },
      ...(redraftError === undefined ? {} : { redraftError }),
      humanizer,
    });
  };
}

function round(usd: number): number {
  return Math.round(usd * 1_000_000) / 1_000_000;
}

export const outreachDraft: Handler = (context) => outreachDraftHandler()(context);
