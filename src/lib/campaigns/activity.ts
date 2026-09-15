import { campaignsCopy } from "@/lib/copy/campaigns";

import type { ActivityEntry } from "./types";

/**
 * A campaign's activity in a rep's words, from its Events (convergence audit
 * §J). Each Event arrives reduced in SQL to a few fields (`campaignActivityFor`),
 * so no research pack, handoff or candidate list is ever read here. Kinds a rep
 * has no use for are not asked for.
 */

export type ActivityRow = {
  id: string;
  kind: string;
  at: Date;
  actorKind: "user" | "system";
  actorUserId: string | null;
  actorName: string | null;
  projection: unknown;
};

const KINDS: Record<string, ActivityEntry["kind"]> = {
  "campaign.created": "created",
  "campaign.brief_changed": "brief_changed",
  "campaign.research_retried": "research_retried",
  "research.completed": "research_done",
  "campaign.confirmed": "confirmed",
  "leadgen.picked": "people_found",
  "leadgen.halted": "people_stopped",
  "leadgen.rerun": "people_rerun",
  "campaign.people_reviewed": "people_reviewed",
  "campaign.reveal_confirmed": "reveal_confirmed",
  "leadgen.revealed": "revealed",
  "campaign.reveal_retried": "reveal_retried",
};

/** The Event kinds the activity reads. */
export const ACTIVITY_KINDS: readonly string[] = Object.keys(KINDS);

const fields = (value: unknown): Record<string, unknown> => (value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {});
const num = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);
const text = (value: unknown): string | null => (typeof value === "string" && value.trim() !== "" ? value : null);

function lineOf(kind: ActivityEntry["kind"], p: Record<string, unknown>): string {
  const c = campaignsCopy;
  const people = (n: number) => `${n} ${n === 1 ? c.activityPerson : c.activityPeople}`;
  switch (kind) {
    case "created":
      return c.activityCreated;
    case "brief_changed":
      return `${p.cause === "widening" ? c.activityBriefWidened : c.activityBriefEdited} ${num(p.briefVersion)}`;
    case "research_retried":
      return c.activityResearchRetried;
    case "research_done":
      return p.outcome === "insufficient" ? c.activityResearchStopped : p.outcome === "partial" ? c.activityResearchPartial : c.activityResearchComplete;
    case "confirmed": {
      const group = text(p.group);
      const lead = p.selection === "chosen" ? c.activityConfirmedChosen : c.activityConfirmed;
      return `${group === null ? c.activityConfirmed.replace(/ for$/, "") : `${lead} ${group}`}. ${c.lawfulBasisConfirmed}.`;
    }
    case "people_found":
      return `${c.activityFound} ${num(p.found)} ${c.of} ${num(p.of)} ${c.activityPeople}`;
    case "people_stopped":
      return c.activityPeopleStopped;
    case "people_rerun": {
      const choice = text(p.choice);
      return p.cause === "choice" && choice !== null ? `${c.activitySearchChoice} ${choice}` : c.activityPeopleRetried;
    }
    case "people_reviewed":
      return `${p.decision === "dropped" ? c.activityDropped : c.activityKept} ${people(num(p.people))}${p.scope === "account" ? ` ${c.activityAtAccount}` : ""}`;
    case "reveal_confirmed":
      return `${c.activityRevealApproved} ${num(p.toReveal) + num(p.known)} ${c.activityEmails}, ${c.activityUpTo} ${num(p.maxCredits)} ${c.activityCredits}`;
    case "revealed":
      return `${c.activityRevealed} ${num(p.revealed) + num(p.known)} ${c.activityReady}, ${num(p.charged)} ${c.activityCreditsUsed}`;
    case "reveal_retried":
      return c.activityRevealRetried;
  }
}

/** The entries, in the order given (newest first), as the rep reading them sees them. */
export function activityOf(rows: readonly ActivityRow[], viewerUserId: string): ActivityEntry[] {
  return rows.flatMap((row) => {
    const kind = KINDS[row.kind];
    if (kind === undefined) return [];
    const actor: ActivityEntry["actor"] =
      row.actorKind === "system" || row.actorUserId === null
        ? { kind: "relay", name: null }
        : row.actorUserId === viewerUserId
          ? { kind: "you", name: null }
          : { kind: "person", name: text(row.actorName)?.split(/\s+/)[0] ?? null };
    return [{ id: row.id, at: row.at.toISOString(), kind, actor, line: lineOf(kind, fields(row.projection)) }];
  });
}
