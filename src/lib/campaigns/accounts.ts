import type { CampaignPerson } from "@prisma/client";

import type { LeadGenHandoff } from "../../../agents/leadgen/input.schema";
import { campaignsCopy } from "@/lib/copy/campaigns";
import { isSeedFirm } from "@/lib/leadgen/rank";

import { readable } from "./readable";
import type { AccountView, BuyerRoleView, FoundPersonView, PeopleFoundView, ReviewView, RolePartView } from "./types";

/**
 * Reviewing people, accounts first (lead gen v2.2 §9a), from the stored
 * candidates and nothing else.
 *
 * An account is its people's `companyKey`: the domain, else the provider's
 * company id, else the name. There is no account record. Accounts come in
 * the order Relay chose them (their first person's rank) and people by rank
 * inside each. Every line is something Relay has: the plan's own search (said
 * once, above the accounts), a firm research named (on that account), and the
 * role each person matched (with each role's needs said once, per role).
 * Nothing is said about a firm that the provider did not return.
 */

export type StoredPerson = Pick<CampaignPerson, "id" | "rank" | "status" | "source" | "whyPicked" | "companyKey" | "preview" | "rolePart" | "roleTitle" | "review">;

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

export function accountsOf(rows: readonly StoredPerson[], handoff: LeadGenHandoff): AccountView[] {
  const roles = handoff.version === 2;

  const byKey = new Map<string, StoredPerson[]>();
  for (const row of [...rows].filter((row) => row.status === "chosen").sort((a, b) => a.rank - b.rank)) {
    byKey.set(row.companyKey, [...(byKey.get(row.companyKey) ?? []), row]);
  }
  return [...byKey.values()].map((members) => {
    const first = previewOf(members[0]!.preview);
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
        role: row.rolePart,
        why: whyOf(row, roles),
        review: reviewOf(row.review),
      };
    });
    const seed = isSeedFirm(
      { providerId: members[0]!.id, name: first.name, title: first.title, company: first.company, ...(first.domain === null ? {} : { domain: first.domain }), hasEmail: false, emailRevealCredits: null },
      handoff.seedFirms,
    );
    return {
      personId: members[0]!.id,
      company: first.company,
      domain: first.domain,
      people,
      parts: PARTS.filter((part) => people.some((person) => person.role === part)),
      evidence: seed ? campaignsCopy.accountFitSeed : null,
    };
  });
}

/** The chosen people's review, counted. */
export function reviewCounts(rows: readonly StoredPerson[]): PeopleFoundView["review"] {
  const chosen = rows.filter((row) => row.status === "chosen").map((row) => reviewOf(row.review));
  return { kept: chosen.filter((review) => review === "kept").length, dropped: chosen.filter((review) => review === "dropped").length, pending: chosen.filter((review) => review === "pending").length };
}

/**
 * What revealing emails would use, for the KEPT people only (v2.2 §9a):
 * pending and dropped people are never revealed. Reused people cost nothing;
 * an email the preview says is free costs nothing; one it gives no price for
 * is counted at the documented per-email price.
 */
export function revealFromKept(rows: readonly StoredPerson[], revealPerEmail = 1): PeopleFoundView["revealEstimate"] {
  const kept = rows.filter((row) => row.status === "chosen" && row.review === "kept");
  const toBuy = kept.filter((row) => {
    const preview = previewOf(row.preview);
    return row.source === "bought" && preview.hasEmail && (preview.emailRevealCredits ?? revealPerEmail) > 0;
  });
  return {
    kept: kept.length,
    toBuy: toBuy.length,
    reused: kept.filter((row) => row.source === "reused").length,
    credits: toBuy.reduce((total, row) => total + (previewOf(row.preview).emailRevealCredits ?? revealPerEmail), 0),
  };
}
