import { peopleCopy } from "@/lib/copy/people";

import { compareStrings, domainKey, firmNameKey, norm } from "./normalise";
import type { ProviderCandidate } from "./provider";

/**
 * Ranking, leadgen v2.1 §8. Code only: no model is involved.
 *
 * Score: exact normalised title +3, otherwise +1 (the candidate came through
 * the title-filtered search); seed-firm match +2; an email available (or
 * already owned, when reused) +2.
 *
 * Selection takes, one at a time, the eligible candidate that maximises
 * `(score, −chosen from the same company, exact title, seed match)`, then the
 * least by `(company key, norm(name), provider id)`. That is a total order,
 * so the same candidate set gives the same pick whatever order the provider
 * returned it in. The per-company cap is enforced here whatever the provider
 * did.
 */

export type Eligible = { candidate: ProviderCandidate; reusedPersonId: string | null };

export type Scored = Eligible & {
  score: number;
  exactTitle: boolean;
  seedMatch: boolean;
  hasEmail: boolean;
  companyKey: string;
  whyPicked: string;
};

export type RankOptions = {
  titles: readonly string[];
  seedFirms: readonly { name: string; domain?: string }[];
  perCompanyMax: number;
  howMany: number;
};

export type RankResult = {
  chosen: (Scored & { rank: number })[];
  spare: Scored[];
  held: { providerId: string; reason: "company_cap" | "duplicate_in_campaign" }[];
};

export function companyKeyOf(candidate: ProviderCandidate): string {
  return domainKey(candidate.domain) ?? (firmNameKey(candidate.company) || norm(candidate.company) || candidate.company);
}

export function isSeedFirm(candidate: ProviderCandidate, seedFirms: RankOptions["seedFirms"]): boolean {
  const domain = domainKey(candidate.domain);
  return seedFirms.some((seed) =>
    // The domain when the seed has one; the name only when it has none.
    seed.domain !== undefined ? domain !== undefined && domainKey(seed.domain) === domain : firmNameKey(seed.name) === firmNameKey(candidate.company),
  );
}

export function score(eligible: Eligible, options: Pick<RankOptions, "titles" | "seedFirms">): Scored {
  const { candidate } = eligible;
  const exactTitle = options.titles.some((title) => norm(title) === norm(candidate.title));
  const seedMatch = isSeedFirm(candidate, options.seedFirms);
  const hasEmail = eligible.reusedPersonId !== null || candidate.hasEmail;
  const scored = {
    ...eligible,
    score: (exactTitle ? 3 : 1) + (seedMatch ? 2 : 0) + (hasEmail ? 2 : 0),
    exactTitle,
    seedMatch,
    hasEmail,
    companyKey: companyKeyOf(candidate),
  };
  return { ...scored, whyPicked: whyPicked(scored) };
}

/** The line a rep reads, from the parts that fired. */
export function whyPicked(scored: Omit<Scored, "whyPicked">): string {
  const why = peopleCopy.why;
  const title = scored.exactTitle ? why.exactTitle : why.relatedTitle;
  const firm = scored.seedMatch ? ` ${why.seedFirm}` : "";
  const email = scored.reusedPersonId !== null ? why.reused : scored.hasEmail ? why.withEmail : why.noEmail;
  return `${title}${firm}, ${email}.`;
}

/** Ascending order of the tie-break keys. */
function tieBreak(a: Scored, b: Scored): number {
  return (
    compareStrings(a.companyKey, b.companyKey) ||
    compareStrings(norm(a.candidate.name), norm(b.candidate.name)) ||
    compareStrings(a.candidate.providerId, b.candidate.providerId)
  );
}

/** Negative when `a` ranks before `b`, given how many each one's company already has. */
function before(a: Scored, b: Scored, taken: ReadonlyMap<string, number>): number {
  return (
    b.score - a.score ||
    (taken.get(a.companyKey) ?? 0) - (taken.get(b.companyKey) ?? 0) ||
    Number(b.exactTitle) - Number(a.exactTitle) ||
    Number(b.seedMatch) - Number(a.seedMatch) ||
    tieBreak(a, b)
  );
}

export function rankCandidates(eligible: readonly Eligible[], options: RankOptions): RankResult {
  const pool = eligible.map((entry) => score(entry, options));
  const taken = new Map<string, number>();
  const persons = new Set<string>();
  const chosen: (Scored & { rank: number })[] = [];
  const held: RankResult["held"] = [];
  const used = new Set<Scored>();

  while (chosen.length < options.howMany) {
    let best: Scored | undefined;
    for (const entry of pool) {
      if (used.has(entry)) continue;
      if ((taken.get(entry.companyKey) ?? 0) >= options.perCompanyMax) continue;
      if (entry.reusedPersonId !== null && persons.has(entry.reusedPersonId)) continue;
      if (best === undefined || before(entry, best, taken) < 0) best = entry;
    }
    if (best === undefined) break;
    used.add(best);
    taken.set(best.companyKey, (taken.get(best.companyKey) ?? 0) + 1);
    if (best.reusedPersonId !== null) persons.add(best.reusedPersonId);
    chosen.push({ ...best, rank: chosen.length + 1 });
  }

  const spare: Scored[] = [];
  const rest = pool.filter((entry) => !used.has(entry)).sort((a, b) => before(a, b, new Map()));
  for (const entry of rest) {
    if (entry.reusedPersonId !== null && persons.has(entry.reusedPersonId)) {
      held.push({ providerId: entry.candidate.providerId, reason: "duplicate_in_campaign" });
    } else if ((taken.get(entry.companyKey) ?? 0) >= options.perCompanyMax) {
      held.push({ providerId: entry.candidate.providerId, reason: "company_cap" });
    } else {
      spare.push(entry);
    }
  }
  return { chosen, spare, held };
}
