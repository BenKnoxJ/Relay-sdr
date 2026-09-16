import type { CampaignPerson } from "@prisma/client";

import type { LeadGenHandoff } from "../../../agents/leadgen/input.schema";
import { campaignsCopy } from "@/lib/copy/campaigns";
import { isSeedFirm } from "@/lib/leadgen/rank";

import { readable } from "./readable";
import type { AccountView, BuyerRoleView, FoundPersonView, PeopleFoundView, RevealStateView, ReviewView, RolePartView } from "./types";

/**
 * Reviewing people, accounts first (lead gen v2.2 §9a), from the stored
 * candidates and nothing else.
 *
 * Accounts that still need the rep come first: any pending person, then
 * accounts with somebody kept, then accounts wholly dropped. Inside each
 * group they keep Relay's order (their first person's rank), so review order
 * never changes who was chosen or how they rank.
 *
 * An account is its people's `companyKey`: the domain, else the provider's
 * company id, else the name. There is no account record. Accounts come in
 * the order Relay chose them (their first person's rank) and people by rank
 * inside each. Every line is something Relay has: the plan's own search (said
 * once, above the accounts), a firm research named (on that account), and the
 * role each person matched (with each role's needs said once, per role).
 * Nothing is said about a firm that the provider did not return.
 */

export type StoredPerson = Pick<CampaignPerson, "id" | "rank" | "status" | "source" | "whyPicked" | "companyKey" | "preview" | "rolePart" | "roleTitle" | "review"> &
  Partial<Pick<CampaignPerson, "reveal" | "revealHold" | "roleMatch">> & { person?: { email: string } | null };

/** What the search actually used, from the result Event: labels and ranges, never provider ids. */
export type Effective = { industries: string[]; sizeBand: { min: number; max: number } | null } | null;

const PARTS: readonly RolePartView[] = ["runs", "champions", "signs"];
/** The provider's open top size bucket is stored as a very large number. */
const OPEN_ENDED_AT = 1_000_000_000;

type Preview = { name: string; title: string; company: string; domain: string | null; city: string | null; hasEmail: boolean; emailRevealCredits: number | null };

/** A stored candidate's preview, as the rep reads it. */
export function previewOf(value: unknown): Preview {
  const preview = value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const text = (key: string) => (typeof preview[key] === "string" ? (preview[key] as string) : "");
  const credits = preview.emailRevealCredits;
  return {
    name: text("name"),
    title: text("title"),
    company: text("company"),
    domain: text("domain") === "" ? null : text("domain"),
    city: text("city") === "" ? null : text("city"),
    hasEmail: preview.hasEmail === true,
    emailRevealCredits: typeof credits === "number" && Number.isInteger(credits) && credits >= 0 ? credits : null,
  };
}

/** The `effective` block a `leadgen.picked` Event records, read defensively. */
export function effectiveOf(after: unknown): Effective {
  const effective = after !== null && typeof after === "object" ? (after as { effective?: unknown }).effective : undefined;
  if (effective === null || typeof effective !== "object") return null;
  const { industries, sizeBand } = effective as { industries?: unknown; sizeBand?: unknown };
  const labels = Array.isArray(industries)
    ? industries.flatMap((entry) => (entry !== null && typeof entry === "object" && typeof (entry as { label?: unknown }).label === "string" ? [(entry as { label: string }).label] : []))
    : [];
  const band = sizeBand as { min?: unknown; max?: unknown } | undefined;
  return {
    industries: [...new Set(labels)],
    sizeBand: band !== undefined && typeof band.min === "number" && typeof band.max === "number" ? { min: band.min, max: band.max } : null,
  };
}

/** The line every account shares, said once above them: the plan's own search, as it was run. */
export function searchLine(handoff: LeadGenHandoff, effective: Effective): string {
  const c = campaignsCopy;
  const countries = handoff.targeting.countries.map((iso) => (c.countries as Record<string, string>)[iso] ?? iso).join(", ");
  const industries = effective !== null && effective.industries.length > 0 ? effective.industries : handoff.targeting.industries;
  const band = effective?.sizeBand ?? handoff.targeting.sizeBand;
  const size = band.max >= OPEN_ENDED_AT ? `${band.min} ${c.accountOrMore} ${c.accountEmployees}` : `${band.min} ${c.accountSizeTo} ${band.max} ${c.accountEmployees}`;
  return `${c.accountFitSearch} ${[countries, industries.join(", "), size].join(", ")}.`;
}

function reviewOf(value: string): ReviewView {
  return value === "kept" || value === "dropped" ? value : "pending";
}

/** The confirmed group's roles, once each, runs first, with their needs as research wrote them. Empty for a v2.1 run. */
export function buyerRolesOf(handoff: LeadGenHandoff): BuyerRoleView[] {
  if (handoff.version !== 2) return [];
  return PARTS.flatMap((part) => handoff.buyerRoles.filter((role) => role.part === part).map((role) => ({ part, title: role.title, needs: readable(role.needs) })));
}

/** One short line per person: the role they matched, or that they did not match one. */
function whyOf(row: StoredPerson, roles: boolean): string {
  if (!roles) return row.whyPicked;
  return row.rolePart === null ? campaignsCopy.whyRelated : campaignsCopy.whyRole[row.rolePart];
}

/**
 * What Relay actually holds on a person, as short phrases (product-truth
 * pass): how the title matched the plan's role, whether the provider lists an
 * email, that research named the firm, that Relay already knows them. Read
 * off the stored row; nothing is inferred, and a row that says nothing gets
 * an empty list rather than a filler line.
 */
function evidenceOf(row: StoredPerson, preview: Preview, seed: boolean, roles: boolean): string[] {
  const c = campaignsCopy;
  const lines: string[] = [];
  // Only the match the row records: no recorded match says nothing about the title.
  if (roles && row.rolePart !== null && row.roleMatch === "exact") lines.push(c.evidenceExactTitle);
  if (roles && row.rolePart !== null && row.roleMatch === "phrase") lines.push(c.evidenceCloseTitle);
  if (seed) lines.push(c.evidenceSeed);
  if (row.source === "reused") lines.push(c.evidenceReused);
  else lines.push(preview.hasEmail ? c.evidenceEmail : c.evidenceNoEmail);
  return lines;
}

/** A kept person's reveal, as the rep reads it: the email only when it is usable, else why not. */
function revealOf(row: StoredPerson): Pick<FoundPersonView, "reveal" | "email" | "revealWhy"> {
  const reveal = row.reveal ?? null;
  if (reveal === null) return { reveal: null, email: null, revealWhy: null };
  const usable = reveal === "revealed" || reveal === "known";
  const why = campaignsCopy.revealWhy as Record<string, string>;
  return {
    reveal,
    email: usable ? (row.person?.email ?? null) : null,
    revealWhy: usable ? null : reveal === "failed" ? campaignsCopy.revealFailedWhy : (why[row.revealHold ?? ""] ?? why[reveal] ?? null),
  };
}

/**
 * The accounts, accounts first. While the rep is reviewing, the accounts
 * with someone still to decide come first (in Relay's order), then the
 * decided ones, so the page opens on the work (final MVP pass). Once Reveal
 * emails is pressed (`keptOnly`), only the kept people are listed, in
 * Relay's order: nobody else was, or will be, revealed.
 */
export function accountsOf(rows: readonly StoredPerson[], handoff: LeadGenHandoff, keptOnly = false): AccountView[] {
  const roles = handoff.version === 2;

  const byKey = new Map<string, StoredPerson[]>();
  for (const row of [...rows].filter((row) => row.status === "chosen" && (!keptOnly || row.review === "kept")).sort((a, b) => a.rank - b.rank)) {
    byKey.set(row.companyKey, [...(byKey.get(row.companyKey) ?? []), row]);
  }
  const accounts = [...byKey.values()].map((members) => {
    const first = previewOf(members[0]!.preview);
    const seed = isSeedFirm(
      { providerId: members[0]!.id, name: first.name, title: first.title, company: first.company, ...(first.domain === null ? {} : { domain: first.domain }), hasEmail: false, emailRevealCredits: null },
      handoff.seedFirms,
    );
    const people: FoundPersonView[] = members.map((row) => {
      const preview = previewOf(row.preview);
      return {
        id: row.id,
        rank: row.rank,
        name: preview.name,
        title: preview.title,
        company: preview.company,
        city: preview.city,
        reused: row.source === "reused",
        hasEmail: row.source === "reused" || preview.hasEmail,
        role: row.rolePart,
        why: whyOf(row, roles),
        evidence: evidenceOf(row, preview, seed, roles),
        review: reviewOf(row.review),
        ...revealOf(row),
      };
    });
    return {
      personId: members[0]!.id,
      company: first.company,
      domain: first.domain,
      people,
      parts: PARTS.filter((part) => people.some((person) => person.role === part)),
      evidence: seed ? campaignsCopy.accountFitSeed : null,
    };
  });
  // Stable: within a group, Relay's own order stands.
  const needsReview = (account: AccountView) => (account.people.some((person) => person.review === "pending") ? 0 : account.people.some((person) => person.review === "kept") ? 1 : 2);
  return accounts.map((account, order) => ({ account, order })).sort((a, b) => needsReview(a.account) - needsReview(b.account) || a.order - b.order).map(({ account }) => account);
}

/** Candidates Relay found and kept in reserve as weaker matches (`spare`): counted, never listed as people. */
export function spareCount(rows: readonly StoredPerson[]): number {
  return rows.filter((row) => row.status === "spare").length;
}

/** The plan's roles nobody chosen was matched to. */
export function rolesMissingFrom(roles: BuyerRoleView[], rows: readonly StoredPerson[]): BuyerRoleView[] {
  const found = new Set(rows.filter((row) => row.status === "chosen").map((row) => row.rolePart));
  return roles.filter((role) => !found.has(role.part));
}

/** The chosen people's review, counted. */
export function reviewCounts(rows: readonly StoredPerson[]): PeopleFoundView["review"] {
  const chosen = rows.filter((row) => row.status === "chosen").map((row) => reviewOf(row.review));
  return { kept: chosen.filter((review) => review === "kept").length, dropped: chosen.filter((review) => review === "dropped").length, pending: chosen.filter((review) => review === "pending").length };
}

/** Kept people by what their reveal came to, from the rows themselves. */
export function revealTallyOf(rows: readonly StoredPerson[]): Record<RevealStateView, number> {
  const tally: Record<RevealStateView, number> = { revealed: 0, known: 0, no_email: 0, suppressed: 0, held: 0, failed: 0 };
  for (const row of rows) if (row.status === "chosen" && row.reveal !== undefined && row.reveal !== null) tally[row.reveal] += 1;
  return tally;
}
