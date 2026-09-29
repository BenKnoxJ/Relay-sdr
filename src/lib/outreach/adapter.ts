import type { CampaignPerson } from "@prisma/client";

import type { LeadGenHandoff } from "../../../agents/leadgen/input.schema";
import { SEQUENCE, type EvidenceQuote, type LookupResult, type OutreachInput, type RecentDraft, type Sender, type TouchKind } from "../../../agents/outreach/input.schema";
import { hostOf, type Item } from "../../../agents/_shared/item.schema";
import type { ProductFacts } from "../../../agents/research/input.schema";
import { completeModule, deriveArchetype, deriveHook, type PackShape } from "../../../agents/research/output.schema";
import { isSeedFirm } from "@/lib/leadgen/rank";

import type { MessageStandard } from "./standard";
import { loadDefaultVoice, voiceInputOf, type DefaultVoice } from "./voice";
import { SENDER_ASIDE_KINDS } from "./asideKinds";

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
  /** The vendored default hand (`loadDefaultVoice`), for a rep with no samples; loaded from `agents/` when absent. */
  defaultVoice?: DefaultVoice;
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
  /** How many other people in the campaign have been sent each quote, by id (trial fix 1). */
  evidenceUse?: ReadonlyMap<string, number>;
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
 * Who a quote is from: the host of the page it was read on. Never the item's `speaker` (M2 fix 2, Sentinel
 * CWE-345): a speaker is words research read off a web page, and a scraped page whose speaker says it is a
 * regulator would otherwise make its words the regulator's. The drafter names the source in plain words, and
 * the evidence check reads the host's own labels ("fca" from fca.org.uk), so no table of bodies is needed.
 */
export function sourceNameOf(item: { evidence: { urls: string[] } }): string | undefined {
  const url = item.evidence.urls[0];
  return url === undefined ? undefined : hostOf(url);
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

/**
 * A research item good enough to quote to a prospect (M2 fix 2): marked strong, or from a primary source.
 * The 23 Sep review traced six of nine rewrites to what the evidence list offered, weak items included —
 * a vendor's LinkedIn post, and a practitioner quote that argued the opposite of the email twice.
 */
export function isVetted(item: Pick<Item, "confidence" | "evidence">): boolean {
  return item.confidence === "strong" || item.evidence.primary;
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
    // The quotable sources behind the slice. m09's verbatim phrases first (they are lifted from primary
    // sources for exactly this), then the pains and buyer words, then the hook's trigger; only the vetted ones
    // (`isVetted`). m15's proof items carry no stored quote and no url, so none is quotable. The lookup's own
    // quotes are added after.
    evidence: evidenceListOf([...(messaging?.verbatim ?? []), ...archetype.pains, ...archetype.language, ...(hook === undefined ? [] : [hook.whyNow])].filter(isVetted)),
  };
}

/** The campaign as the checks read it: the confirmed group's industries and every group's in m04. */
export function campaignOf(pack: PackShape, handoff: Pick<LeadGenHandoff, "targeting">): NonNullable<OutreachInput["campaign"]> {
  const groups = (completeModule(pack, "m04")?.perArchetype ?? []).map((group) => group.recipe.industries.slice(0, 30)).slice(0, 12);
  return { industries: handoff.targeting.industries.slice(0, 30), ...(groups.length === 0 ? {} : { groups }) };
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
 * Each quote with how many other people in this campaign have already been sent it (trial fix 1), so the
 * drafter can prefer the least used. `used` maps a quote's id to that count; a quote nobody has used says 0.
 */
export function withUsage(slice: OutreachInput["pack"], used: ReadonlyMap<string, number>): OutreachInput["pack"] {
  return { ...slice, evidence: slice.evidence.map((quote) => ({ ...quote, usedBy: used.get(quote.id) ?? 0 })) };
}

/** The evidence list a person's touches may quote: the campaign's research and the lookup's own quotes. */
export function evidenceSliceOf(input: Pick<AdapterFacts, "pack" | "handoff" | "facts" | "lookup" | "evidenceUse">): OutreachInput["pack"] {
  const slice = withLookupEvidence(packSliceOf(input.pack, input.handoff, liveFacts(input.facts)), input.lookup);
  return input.evidenceUse === undefined ? slice : withUsage(slice, input.evidenceUse);
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
    sender: { ...input.sender, asideKinds: [...SENDER_ASIDE_KINDS] },
    ...(buyerRole === undefined ? {} : { buyerRole }),
    account: {
      company: preview.company,
      ...(preview.domain === undefined ? {} : { domain: preview.domain }),
      ...(seed ? { seedEvidence: "Research named this firm for the plan." } : {}),
    },
    campaign: campaignOf(input.pack, input.handoff),
    touch: touchOf(input.sequence === true ? "email1" : (input.touch ?? "email1"), input.now),
    ...(input.sequence === true ? { sequence: [...SEQUENCE] } : {}),
    thread: (input.thread ?? []).slice(0, 20),
    pack: evidenceSliceOf(input),
    facts,
    // §15 resolution 1: the eight most recent email samples; the vendored hand when there are none (voice round).
    voice: voiceInputOf(input.voice, input.defaultVoice ?? loadDefaultVoice()),
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
