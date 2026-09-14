import { peopleCopy } from "@/lib/copy/people";

import { compareStrings, norm } from "./normalise";
import { score, type Eligible, type RankOptions, type RankResult, type Scored } from "./rank";
import { PART_ORDER, matchRole, type RoleMatch, type RolePart, type RoleTable } from "./roles";

/**
 * Account-led allocation, leadgen v2.2 §8a. Ordinary deterministic code: no
 * model, no optimiser, no scoring framework.
 *
 * Every candidate keeps its v2.1 §8 score, and gains the confirmed group's
 * role its title plays (`matchRole`). A candidate is **strong** when it plays
 * a role or carries an exact recipe title; nothing weak is ever chosen.
 *
 * Accounts are ordered by how many distinct roles they offer, then a seed
 * firm, then their best score, then their key. Inside an account, runs comes
 * before champions before signs, an exact match before a phrase match, then
 * score, name and provider id. Both orders are total, so the provider's order
 * never decides anything.
 *
 * Then four passes, stopping at `howMany`:
 *   1. leads: accounts in order each take their first strong person, until
 *      `ceil(howMany / 2)` accounts have one. A lead whose title already leads
 *      `ceil(howMany / 4)` accounts gives way to the account's next person;
 *   2. a complement: each lead account adds a person with a role it lacks;
 *   3. a third role, the same way;
 *   4. more accounts, a lead each.
 * Never two people with one role at an account, never more than the per
 * company cap, and never padding: fewer than asked is the answer.
 */

export type AllocateOptions = RankOptions & { roles: RoleTable };

export type Placed = Scored & { role: RoleMatch | null; strong: boolean };

export type AllocationResult = Omit<RankResult, "chosen" | "spare"> & {
  chosen: (Placed & { rank: number })[];
  spare: Placed[];
  /** The accounts pass 1 gave a lead, in account order: what the complement search asks inside. */
  leadAccounts: string[];
};

/** v2.2 §8a: how many accounts a run aims for. */
export function targetAccountsFor(howMany: number): number {
  return Math.ceil(howMany / 2);
}

/** v2.2 §8a: how many accounts one exact title may lead. */
export function leadTitleCapFor(howMany: number): number {
  return Math.ceil(howMany / 4);
}

const PART_RANK: Record<RolePart, number> = { runs: 0, champions: 1, signs: 2 };
const partRank = (entry: Placed) => (entry.role === null ? PART_ORDER.length : PART_RANK[entry.role.part]);
const howRank = (entry: Placed) => (entry.role === null ? 2 : entry.role.how === "exact" ? 0 : 1);

/** The line a rep reads, from the parts that fired. */
function whyPlaced(entry: Omit<Placed, "whyPicked">): string {
  const why = peopleCopy.why;
  const title = entry.role === null ? (entry.exactTitle ? why.exactTitle : why.relatedTitle) : entry.role.how === "exact" ? why.roleExact : why.rolePhrase;
  const firm = entry.seedMatch ? ` ${why.seedFirm}` : "";
  const email = entry.reusedPersonId !== null ? why.reused : entry.hasEmail ? why.withEmail : why.noEmail;
  return `${title}${firm}, ${email}.`;
}

export function place(eligible: Eligible, options: AllocateOptions): Placed {
  const scored = score(eligible, options);
  const role = matchRole(eligible.candidate.title, options.roles);
  const placed = { ...scored, role, strong: role !== null || scored.exactTitle };
  return { ...placed, whyPicked: whyPlaced(placed) };
}

/** Ascending order inside one account. */
function withinAccount(a: Placed, b: Placed): number {
  return (
    partRank(a) - partRank(b) ||
    howRank(a) - howRank(b) ||
    b.score - a.score ||
    compareStrings(norm(a.candidate.name), norm(b.candidate.name)) ||
    compareStrings(a.candidate.providerId, b.candidate.providerId)
  );
}

type Account = { key: string; members: Placed[]; parts: number; seed: boolean; best: number };

/** Ascending order of accounts. */
function accountOrder(a: Account, b: Account): number {
  return b.parts - a.parts || Number(b.seed) - Number(a.seed) || b.best - a.best || compareStrings(a.key, b.key);
}

function accountsOf(pool: readonly Placed[]): Account[] {
  const byKey = new Map<string, Placed[]>();
  for (const entry of pool) byKey.set(entry.companyKey, [...(byKey.get(entry.companyKey) ?? []), entry]);
  return [...byKey.entries()]
    .map(([key, members]) => {
      const strong = members.filter((member) => member.strong);
      return {
        key,
        members: [...members].sort(withinAccount),
        parts: new Set(strong.flatMap((member) => (member.role === null ? [] : [member.role.part]))).size,
        seed: strong.some((member) => member.seedMatch),
        best: strong.reduce((best, member) => Math.max(best, member.score), 0),
      };
    })
    .sort(accountOrder);
}

export function allocate(eligible: readonly Eligible[], options: AllocateOptions): AllocationResult {
  const pool = eligible.map((entry) => place(entry, options));
  const accounts = accountsOf(pool);
  const target = targetAccountsFor(options.howMany);
  const titleCap = leadTitleCapFor(options.howMany);

  const chosen: (Placed & { rank: number })[] = [];
  const used = new Set<Placed>();
  const persons = new Set<string>();
  const taken = new Map<string, Placed[]>();
  const leadsByTitle = new Map<string, number>();
  const leadAccounts: string[] = [];

  const full = () => chosen.length >= options.howMany;
  const free = (entry: Placed) => !used.has(entry) && (entry.reusedPersonId === null || !persons.has(entry.reusedPersonId));
  const take = (account: Account, entry: Placed) => {
    used.add(entry);
    if (entry.reusedPersonId !== null) persons.add(entry.reusedPersonId);
    taken.set(account.key, [...(taken.get(account.key) ?? []), entry]);
    chosen.push({ ...entry, rank: chosen.length + 1 });
  };
  const lead = (account: Account): boolean => {
    const entry = account.members.find((member) => member.strong && free(member) && (leadsByTitle.get(norm(member.candidate.title)) ?? 0) < titleCap);
    if (entry === undefined) return false;
    leadsByTitle.set(norm(entry.candidate.title), (leadsByTitle.get(norm(entry.candidate.title)) ?? 0) + 1);
    take(account, entry);
    return true;
  };
  const complement = (account: Account) => {
    const mine = taken.get(account.key) ?? [];
    if (mine.length >= options.perCompanyMax) return;
    const has = new Set(mine.flatMap((member) => (member.role === null ? [] : [member.role.part])));
    // Members are already in within-account order, so the first missing role is runs, then champions, then signs.
    const entry = account.members.find((member) => member.role !== null && !has.has(member.role.part) && free(member));
    if (entry !== undefined) take(account, entry);
  };

  // Pass 1: coverage before depth.
  for (const account of accounts) {
    if (full() || leadAccounts.length >= target) break;
    if (lead(account)) leadAccounts.push(account.key);
  }
  const leading = accounts.filter((account) => leadAccounts.includes(account.key));
  // Passes 2 and 3: a role each account lacks, then a third.
  for (let pass = 0; pass < 2; pass += 1) {
    for (const account of leading) {
      if (full()) break;
      complement(account);
    }
  }
  // Pass 4: further accounts, a lead each.
  for (const account of accounts) {
    if (full()) break;
    if (!taken.has(account.key)) lead(account);
  }

  const held: RankResult["held"] = [];
  const spare: Placed[] = [];
  const order = new Map(accounts.map((account, index) => [account.key, index]));
  const rest = pool
    .filter((entry) => !used.has(entry))
    .sort((a, b) => (order.get(a.companyKey) ?? 0) - (order.get(b.companyKey) ?? 0) || withinAccount(a, b));
  for (const entry of rest) {
    if (entry.reusedPersonId !== null && persons.has(entry.reusedPersonId)) {
      held.push({ providerId: entry.candidate.providerId, reason: "duplicate_in_campaign" });
    } else if ((taken.get(entry.companyKey)?.length ?? 0) >= options.perCompanyMax) {
      held.push({ providerId: entry.candidate.providerId, reason: "company_cap" });
    } else {
      // One person is one enrolment in the spare pool too.
      if (entry.reusedPersonId !== null) persons.add(entry.reusedPersonId);
      spare.push(entry);
    }
  }
  return { chosen, spare, held, leadAccounts };
}
