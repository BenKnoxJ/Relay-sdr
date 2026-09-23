import type { CampaignPerson } from "@prisma/client";

import type { LeadGenHandoff } from "../../../agents/leadgen/input.schema";
import { SEQUENCE, type EvidenceQuote, type LookupResult, type OutreachInput, type RecentDraft, type Sender, type TouchKind } from "../../../agents/outreach/input.schema";
import { hostOf, type Item } from "../../../agents/_shared/item.schema";
import type { ProductFacts } from "../../../agents/research/input.schema";
import { completeModule, deriveArchetype, deriveHook, type PackShape } from "../../../agents/research/output.schema";
import { isSeedFirm } from "@/lib/leadgen/rank";

import type { MessageStandard } from "./standard";

/**
 * The thin adapter at the campaign boundary (outreach v2.1 §2): Relay's
 * campaign, account, buyer role and revealed person, and the research pack,
 * as the Outreach input. Nothing here decides anything a rep would see; it
 * copies, filters and caps.
 */

export type VoiceSamples = { samples: { text: string; addedAt: string }[]; howIWrite: string };

export type AdapterFacts = {
  /** The kept, revealed person's campaign row. */
  row: Pick<CampaignPerson, "id" | "providerId" | "preview" | "rolePart" | "roleTitle" | "companyKey">;
  /** Their usable work email, from the Person. */
  email: string;
  /** Who is writing: the rep and their company (`senderOf`). */
  sender: Sender;
  handoff: LeadGenHandoff;
  pack: PackShape;
  facts: ProductFacts;
  voice: VoiceSamples;
  standard: MessageStandard;
  lookup: LookupResult;
  recentDrafts: RecentDraft[];
  redraft?: OutreachInput["redraft"];
  now: Date;
  /** The touch to write; Email 1 when absent. */
  touch?: TouchKind;
  /** The earlier touches' words, so a follow-up does not repeat them (P2). */
  thread?: OutreachInput["thread"];
  /** P2: one answer writes the whole sequence, starting at Email 1. */
  sequence?: boolean;
};

type Preview = { name: string; title: string; company: string; domain?: string; city?: string };

export function previewFields(value: unknown): Preview {
  const preview = value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const text = (key: string) => (typeof preview[key] === "string" ? (preview[key] as string).trim() : "");
  return {
    name: text("name"),
    title: text("title"),
    company: text("company"),
    ...(text("domain") === "" ? {} : { domain: text("domain") }),
    ...(text("city") === "" ? {} : { city: text("city") }),
  };
}

export function firstNameOf(name: string): string {
  return name.trim().split(/\s+/)[0] ?? name;
}

/** The company a rep writes from when their org has no display name of its own. */
export const DEFAULT_SENDER_COMPANY = "Conversant";

/**
 * Who is writing (P5c): the rep's first name, from their user record (their
 * name, else their email's local part), and their company. An org's name is
 * its email domain until someone gives it a display name, and a domain is not
 * a company a prospect is introduced to, so it reads as `Conversant`.
 */
export function senderOf(input: { userName: string | null; email: string; orgName: string | null }): Sender {
  const named = firstNameOf(input.userName?.trim() ?? "");
  const localPart = input.email.split("@")[0] ?? "";
  // The first word of the local part (`ben.knox-johnston` is Ben), or all of it when it has no word to split out.
  const local = localPart.split(/[._+-]/).find((part) => part !== "") ?? localPart;
  const fromEmail = local === "" ? "" : local.charAt(0).toUpperCase() + local.slice(1).toLowerCase();
  const orgName = input.orgName?.trim() ?? "";
  const isDomain = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(orgName);
  return {
    firstName: (named !== "" ? named : fromEmail).slice(0, 100),
    company: (orgName === "" || isDomain ? DEFAULT_SENDER_COMPANY : orgName).slice(0, 200),
  };
}

/** The person's role, with its needs as research wrote them; none for a Related role. */
export function buyerRoleOf(row: AdapterFacts["row"], handoff: LeadGenHandoff): OutreachInput["buyerRole"] {
  if (row.rolePart === null || handoff.version !== 2) return undefined;
  const role = handoff.buyerRoles.find((candidate) => candidate.part === row.rolePart && candidate.title === row.roleTitle) ?? handoff.buyerRoles.find((candidate) => candidate.part === row.rolePart);
  if (role === undefined) return undefined;
  return { id: `role-${role.part}`, part: role.part, title: role.title, needs: role.needs };
}


/**
 * The plain words a message would name a source by, from its host: the FCA's
 * own site is "the FCA", the ombudsman's is "the ombudsman". Anything not in
 * the table falls back to the host itself, which is honest if plain — a
 * drafter may not attribute a quote to a source Relay cannot name.
 */
const SOURCE_NAMES: readonly (readonly [RegExp, string])[] = [
  [/(^|\.)fca\.org\.uk$/, "the FCA"],
  [/(^|\.)financial-ombudsman\.org\.uk$/, "the ombudsman"],
  [/(^|\.)handbook\.fca\.org\.uk$/, "the FCA"],
  [/(^|\.)gov\.uk$/, "the government"],
  [/(^|\.)ico\.org\.uk$/, "the ICO"],
];

export function sourceNameOf(item: { speaker?: string; evidence: { urls: string[] } }): string | undefined {
  const url = item.evidence.urls[0];
  if (url === undefined) return undefined;
  const host = hostOf(url);
  const known = SOURCE_NAMES.find(([pattern]) => pattern.test(host))?.[1];
  if (known !== undefined) return known;
  const speaker = item.speaker?.trim() ?? "";
  return speaker !== "" ? speaker : host;
}

/**
 * An item as an evidence quote, or nothing.
 *
 * Nothing is the common and correct answer: an item with no stored `quote`
 * and an item with no url are both unquotable, and passing either as
 * quotable is exactly the drift M2 exists to stop (the 22 Sep re-review: a
 * pain's paraphrase reached the drafter as if it were the FCA's wording).
 */
export function evidenceQuoteOf(item: Pick<Item, "id" | "quote" | "speaker" | "publishedAt" | "evidence">): EvidenceQuote | undefined {
  const quote = item.quote?.trim() ?? "";
  const url = item.evidence.urls[0];
  const sourceName = sourceNameOf(item);
  if (quote === "" || url === undefined || sourceName === undefined) return undefined;
  return { id: item.id, quote, sourceName, url, ...(item.publishedAt === undefined ? {} : { date: item.publishedAt }) };
}

/** The quotable evidence behind a slice, deduplicated by id, best sources first. */
export function evidenceListOf(items: readonly Pick<Item, "id" | "quote" | "speaker" | "publishedAt" | "evidence">[]): EvidenceQuote[] {
  const seen = new Set<string>();
  const list: EvidenceQuote[] = [];
  for (const item of items) {
    const quote = evidenceQuoteOf(item);
    if (quote === undefined || seen.has(quote.id)) continue;
    seen.add(quote.id);
    list.push(quote);
  }
  return list.slice(0, 12);
}

/** The confirmed archetype's slice of the pack: pains and words, hook, m09's angles and lines, m15's allowed proof. */
export function packSliceOf(pack: PackShape, handoff: LeadGenHandoff, facts: ProductFacts): OutreachInput["pack"] {
  const archetypeId = handoff.buyerGroup.id;
  const archetype = deriveArchetype(pack, archetypeId);
  if (archetype === undefined) throw new Error(`outreach: the pack has no archetype ${archetypeId}`);
  const hook = deriveHook(pack, archetypeId);
  const messaging = completeModule(pack, "m09")?.perArchetype.find((entry) => entry.archetypeId === archetypeId);
  const live = new Set(facts.facts.map((fact) => fact.id));
  const proof = (completeModule(pack, "m15")?.proof ?? []).filter((item) => item.allowed && live.has(item.factId));
  return {
    briefVersion: handoff.campaign.briefVersion,
    archetype,
    ...(hook === undefined ? {} : { hook }),
    angles: [...(messaging?.angles ?? [])].sort((a, b) => a.rank - b.rank).slice(0, 5),
    doDont: (messaging?.doDont ?? []).slice(0, 12),
    verbatim: (messaging?.verbatim ?? []).slice(0, 8),
    proof: proof.slice(0, 6).map((item) => ({ factId: item.factId, text: item.text, ...(item.note === undefined ? {} : { note: item.note }) })),
    // M2: the quotable sources behind the slice. m09's verbatim phrases first —
    // they are lifted from primary sources for exactly this — then the pains
    // and buyer words, then the hook's trigger. m15's proof items carry no
    // stored quote and no url of their own, so none of them is quotable.
    evidence: evidenceListOf([...(messaging?.verbatim ?? []), ...archetype.pains, ...archetype.language, ...(hook === undefined ? [] : [hook.whyNow])]),
  };
}

/** Only live facts reach the writer (§3). */
export function liveFacts(facts: ProductFacts): ProductFacts {
  return { ...facts, facts: facts.facts.filter((fact) => fact.status === "live") };
}

/**
 * The lookup's own quotes added to the slice's evidence. A lookup item is the
 * one thing in the input that is about *this* person or firm, so its words are
 * the most valuable quote a touch can carry, and it is held to the same bar:
 * a stored quote and a url, or it is not quotable.
 */
export function withLookupEvidence(slice: OutreachInput["pack"], lookup: LookupResult): OutreachInput["pack"] {
  const extra = evidenceListOf(lookup.items).filter((quote) => !slice.evidence.some((known) => known.id === quote.id));
  return extra.length === 0 ? slice : { ...slice, evidence: [...extra, ...slice.evidence].slice(0, 12) };
}

/**
 * The standard's approved gives added to the slice's evidence.
 *
 * They go first: they are the curated, scope-checked sentences a person
 * signed off, and the pack's own quotes are whatever research happened to
 * store. `scope` is dropped here — it is guidance for whoever maintains the
 * list, and handing the model a note about what a quote does not say invites
 * it to write about that instead.
 */
export function withApprovedGives(slice: OutreachInput["pack"], standard: MessageStandard): OutreachInput["pack"] {
  const gives = standard.gives.map(({ scope: _scope, ...quote }) => quote).filter((quote) => !slice.evidence.some((known) => known.id === quote.id));
  return gives.length === 0 ? slice : { ...slice, evidence: [...gives, ...slice.evidence].slice(0, 12) };
}

export function buildOutreachInput(input: AdapterFacts): OutreachInput {
  const preview = previewFields(input.row.preview);
  const facts = liveFacts(input.facts);
  const seed = isSeedFirm(
    { providerId: input.row.providerId, name: preview.name, title: preview.title, company: preview.company, ...(preview.domain === undefined ? {} : { domain: preview.domain }), hasEmail: true, emailRevealCredits: null },
    input.handoff.seedFirms,
  );
  const buyerRole = buyerRoleOf(input.row, input.handoff);
  return {
    person: {
      id: input.row.id,
      name: preview.name,
      firstName: firstNameOf(preview.name),
      title: preview.title,
      company: preview.company,
      ...(preview.domain === undefined ? {} : { domain: preview.domain }),
      email: input.email,
      ...(preview.city === undefined ? {} : { city: preview.city }),
    },
    sender: input.sender,
    ...(buyerRole === undefined ? {} : { buyerRole }),
    account: {
      company: preview.company,
      ...(preview.domain === undefined ? {} : { domain: preview.domain }),
      ...(seed ? { seedEvidence: "Research named this firm for the plan." } : {}),
    },
    touch: touchOf(input.sequence === true ? "email1" : (input.touch ?? "email1"), input.now),
    ...(input.sequence === true ? { sequence: [...SEQUENCE] } : {}),
    thread: (input.thread ?? []).slice(0, 20),
    pack: withApprovedGives(withLookupEvidence(packSliceOf(input.pack, input.handoff, facts), input.lookup), input.standard),
    facts,
    // §15 resolution 1: the eight most recent email samples.
    voice: { email: input.voice.samples.slice(-8).map((sample) => sample.text), linkedin: [], howIWrite: input.voice.howIWrite.slice(0, 2000) },
    standard: input.standard,
    lookup: input.lookup,
    recentDrafts: input.recentDrafts.slice(0, 20),
    ...(input.redraft === undefined ? {} : { redraft: input.redraft }),
  };
}

/** A touch at its place in the sequence. */
export function touchOf(kind: TouchKind, now: Date): OutreachInput["touch"] {
  return { kind, ordinal: SEQUENCE.indexOf(kind) + 1, dueAt: now.toISOString() };
}

/** What the lookup must touch to be relevant: the role's needs, the plan's pains and hook (v2.1 §3). */
export function relevanceTerms(slice: OutreachInput["pack"], buyerRole: OutreachInput["buyerRole"]): string[] {
  return [
    buyerRole?.needs ?? "",
    slice.archetype.situation,
    ...slice.archetype.pains.map((pain) => pain.text),
    slice.hook?.text ?? "",
    ...slice.angles.map((angle) => angle.text),
  ].filter((term) => term !== "");
}
