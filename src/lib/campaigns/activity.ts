import { campaignsCopy } from "@/lib/copy/campaigns";
import { findMoreCopy } from "@/lib/copy/findMore";
import { outreachStartCopy } from "@/lib/copy/outreachStart";
import { dayLabel, isIsoDate } from "@/lib/outreach/sequence";

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

/**
 * The Event kinds the activity reads, and what each is called here. The SQL
 * projection in `src/lib/repo/campaignActivity.ts` names the fields each kind
 * needs; a kind added here needs its line there too (a kind with no
 * projection reads as no fields, and its line falls back to plain words).
 */
const KINDS: Record<string, ActivityEntry["kind"]> = {
  "campaign.created": "created",
  "campaign.brief_changed": "brief_changed",
  "campaign.research_retried": "research_retried",
  "research.completed": "research_done",
  "campaign.confirmed": "confirmed",
  "leadgen.picked": "people_found",
  "leadgen.halted": "people_stopped",
  "leadgen.rerun": "people_rerun",
  "campaign.more_people": "more_people",
  "campaign.people_reviewed": "people_reviewed",
  "campaign.reveal_confirmed": "reveal_confirmed",
  "leadgen.revealed": "revealed",
  "campaign.reveal_retried": "reveal_retried",
  "outreach.requested": "drafts_requested",
  "outreach.drafted": "drafted",
  "draft.approved": "draft_approved",
  "draft.rejected": "draft_rejected",
  "outreach.started": "outreach_started",
  "outreach.paused": "outreach_paused",
  "outreach.resumed": "outreach_resumed",
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
      return `${group === null ? c.activityConfirmedNoGroup : `${lead} ${group}`}. ${c.lawfulBasisConfirmed}.`;
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
    case "drafts_requested":
      return `${c.activityDraftsRequested} ${num(p.people)} ${c.activityDraftsToWrite}`;
    case "drafted": {
      const who = text(p.person) ?? "";
      return `${p.state === "needs_you" ? c.activityDraftedNeedsYou : p.state === "failed" ? c.activityDraftedFailed : c.activityDrafted} ${who}`.trim();
    }
    case "draft_approved":
      return `${c.activityDraftApproved} ${text(p.person) ?? ""}${p.edited === true ? ` ${c.activityDraftApprovedEdited}` : ""}`.trim();
    case "draft_rejected": {
      const reason = text(p.reason);
      const words = reason !== null && reason in c.activityDraftReasons ? c.activityDraftReasons[reason as keyof typeof c.activityDraftReasons] : null;
      return `${c.activityDraftRejected} ${text(p.person) ?? ""}${words === null ? "" : ` (${words})`}`.trim();
    }
    case "outreach_started":
    {
      const on = text(p.startOn);
      return `${outreachStartCopy.activityStarted} ${on !== null && isIsoDate(on) ? dayLabel(on) : ""} ${outreachStartCopy.activityFor} ${people(num(p.people))}`;
    }
    case "outreach_paused":
      return outreachStartCopy.activityPaused;
    case "outreach_resumed":
      return outreachStartCopy.activityResumed;
    case "more_people": {
      const cap = num(p.cap);
      return `${findMoreCopy.activity} ${people(num(p.howMany))}, ${findMoreCopy.activityBatch} ${num(p.batch)}${cap > 0 ? ` ${findMoreCopy.activityNewCap} ${cap} ${c.activityCredits}` : ""}`;
    }
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
