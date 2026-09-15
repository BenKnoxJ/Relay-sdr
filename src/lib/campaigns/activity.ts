import { campaignsCopy } from "@/lib/copy/campaigns";
import { firstNameFor } from "@/lib/shell";

import { haltLine } from "./state";
import type { ActivityEntry } from "./types";

/**
 * Activity, in a rep's words (final MVP pass): each of the campaign's own
 * Events as one line, from the reduced projection the repo reads
 * (`src/lib/repo/campaignActivity.ts`). Nothing here is a count of work that
 * has not happened, and no machine word reaches the screen: a stored kind
 * or reason is mapped to copy, or the line is left out.
 */

export type ActivityInput = { id: string; kind: string; at: Date | string; actorName: string | null; projection: unknown };

const record = (value: unknown): Record<string, unknown> => (value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {});
const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
const str = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value : null);

/** "14 Sep, 12:05" in the same zone as Home's date (UK pilot). */
export function whenLabel(at: Date): string {
  const parts = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Europe/London" }).formatToParts(at);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((candidate) => candidate.type === type)?.value ?? "";
  return `${part("day")} ${part("month").slice(0, 3)}, ${part("hour")}:${part("minute")}`;
}

const people = (n: number) => `${n} ${n === 1 ? campaignsCopy.accountPerson : campaignsCopy.accountPeople}`;

/** One Event's line and, where there is one, a quieter second line. Null for a kind or shape Relay has no words for. */
export function activityLineOf(row: ActivityInput): { line: string; detail: string | null } | null {
  const c = campaignsCopy;
  const p = record(row.projection);
  switch (row.kind) {
    case "campaign.created":
      return { line: c.activityCreated, detail: null };
    case "campaign.brief_changed": {
      const version = num(p.briefVersion);
      const lead = p.cause === "widening" ? c.activityBriefWidened : c.activityBriefEdited;
      return { line: version === null ? lead : `${lead} (${c.activityVersion} ${version})`, detail: null };
    }
    case "research.completed":
      return { line: p.outcome === "insufficient" ? c.activityResearchStopped : p.partial === true ? c.activityResearchPartial : c.activityResearchDone, detail: null };
    case "campaign.research_retried":
      return { line: c.activityResearchRetried, detail: null };
    case "campaign.confirmed": {
      const group = str(p.groupName);
      const cap = num(p.cap);
      const how = p.selection === "chosen" ? c.activityConfirmedChosen : c.activityConfirmedRecommended;
      const line = [`${c.activityConfirmed} ${group ?? ""}`.trim(), how, ...(cap === null ? [] : [`${c.activityLimit} ${cap} ${c.spendCreditsWord}`])].join(c.noteJoin);
      const lawful = str(p.lawfulBasis);
      return { line, detail: lawful === null ? null : `${c.activityLawful}: ${lawful}` };
    }
    case "leadgen.picked": {
      const n = num(p.n);
      const ofM = num(p.ofM);
      return n === null ? { line: c.activityFound, detail: null } : { line: `${c.activityFound} ${people(n)}${ofM === null ? "" : ` ${c.peopleFoundOf} ${ofM} ${c.activityFoundAsked}`}`, detail: null };
    }
    case "leadgen.halted":
      return { line: `${c.activityHalted} ${haltLine(str(p.reason) ?? "")}`, detail: null };
    case "leadgen.rerun":
      return { line: p.cause === "choice" ? c.activitySearchedWithChoice : c.activitySearchedAgain, detail: null };
    case "campaign.people_reviewed": {
      const count = num(p.count) ?? 0;
      if (count === 0) return null;
      const lead = p.decision === "dropped" ? c.activityDropped : c.activityKept;
      return { line: `${lead} ${people(count)}${p.scope === "account" ? ` ${c.activityAccount}` : ""}`, detail: null };
    }
    case "campaign.reveal_confirmed": {
      const toReveal = num(p.toReveal) ?? 0;
      const max = num(p.maxCredits);
      return { line: `${c.activityRevealConfirmed} ${toReveal} ${c.activityRevealEmails} ${max ?? 0} ${c.spendCreditsWord}`, detail: null };
    }
    case "leadgen.revealed": {
      const tally = record(p.tally);
      const revealed = num(tally.revealed) ?? 0;
      const known = num(tally.known) ?? 0;
      const without = (num(tally.no_email) ?? 0) + (num(tally.suppressed) ?? 0) + (num(tally.held) ?? 0) + (num(tally.failed) ?? 0);
      const parts = [`${c.activityRevealed} ${revealed} ${revealed === 1 ? c.revealButtonEmailOne.replace(",", "") : c.revealButtonEmailMany.replace(",", "")}`];
      if (known > 0) parts.push(`${known} ${c.activityRevealedKnown}`);
      if (without > 0) parts.push(`${without} ${c.activityRevealedWithout}`);
      return { line: parts.join(c.noteJoin), detail: null };
    }
    case "campaign.reveal_retried":
      return { line: c.activityRevealRetried, detail: null };
    default:
      return null;
  }
}

/** The campaign's activity as the rail draws it, newest first. */
export function activityEntriesOf(rows: readonly ActivityInput[]): ActivityEntry[] {
  return rows.flatMap((row) => {
    const words = activityLineOf(row);
    if (words === null) return [];
    const at = row.at instanceof Date ? row.at : new Date(row.at);
    return [{ id: row.id, at: at.toISOString(), when: whenLabel(at), by: row.actorName === null ? null : firstNameFor(row.actorName, ""), line: words.line, detail: words.detail }];
  });
}
