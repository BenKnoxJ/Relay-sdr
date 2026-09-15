import type { CampaignPerson } from "@prisma/client";

import type { LeadGenHandoff } from "../../../agents/leadgen/input.schema";
import type { LookupResult, OutreachInput, RecentDraft } from "../../../agents/outreach/input.schema";
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
  handoff: LeadGenHandoff;
  pack: PackShape;
  facts: ProductFacts;
  voice: VoiceSamples;
  standard: MessageStandard;
  lookup: LookupResult;
  recentDrafts: RecentDraft[];
  redraft?: OutreachInput["redraft"];
  now: Date;
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

/** The person's role, with its needs as research wrote them; none for a Related role. */
export function buyerRoleOf(row: AdapterFacts["row"], handoff: LeadGenHandoff): OutreachInput["buyerRole"] {
  if (row.rolePart === null || handoff.version !== 2) return undefined;
  const role = handoff.buyerRoles.find((candidate) => candidate.part === row.rolePart && candidate.title === row.roleTitle) ?? handoff.buyerRoles.find((candidate) => candidate.part === row.rolePart);
  if (role === undefined) return undefined;
  return { id: `role-${role.part}`, part: role.part, title: role.title, needs: role.needs };
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
  };
}

/** Only live facts reach the writer (§3). */
export function liveFacts(facts: ProductFacts): ProductFacts {
  return { ...facts, facts: facts.facts.filter((fact) => fact.status === "live") };
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
    ...(buyerRole === undefined ? {} : { buyerRole }),
    account: {
      company: preview.company,
      ...(preview.domain === undefined ? {} : { domain: preview.domain }),
      ...(seed ? { seedEvidence: "Research named this firm for the plan." } : {}),
    },
    touch: { kind: "email1", ordinal: 1, dueAt: input.now.toISOString() },
    thread: [],
    pack: packSliceOf(input.pack, input.handoff, facts),
    facts,
    // §15 resolution 1: the eight most recent email samples.
    voice: { email: input.voice.samples.slice(-8).map((sample) => sample.text), linkedin: [], howIWrite: input.voice.howIWrite.slice(0, 2000) },
    standard: input.standard,
    lookup: input.lookup,
    recentDrafts: input.recentDrafts.slice(0, 20),
    ...(input.redraft === undefined ? {} : { redraft: input.redraft }),
  };
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
