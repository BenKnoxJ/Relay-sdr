import type { ActivityEntry } from "@/lib/campaigns/types";
import { campaignsCopy } from "@/lib/copy/campaigns";

/**
 * What has happened to this campaign, newest first (final MVP pass): one
 * line per Event, with when and who. The rail's fourth tab, in place of
 * the six questions. Every line is a thing that happened; a count of
 * work that has not happened is never drawn here.
 */
/** "14 Sep, 12:05" in the UK pilot's zone, the same clock as Home's date. */
function whenLabel(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Europe/London" }).formatToParts(at);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((candidate) => candidate.type === type)?.value ?? "";
  return `${part("day")} ${part("month").slice(0, 3)}, ${part("hour")}:${part("minute")}`;
}

export function ActivityList({ entries }: { entries: readonly ActivityEntry[] }) {
  const c = campaignsCopy;
  if (entries.length === 0) {
    return (
      <p data-testid="activity-empty" className="type-small text-muted">
        {c.activityEmpty}
      </p>
    );
  }
  return (
    <ol data-testid="activity" className="grid">
      {entries.map((entry) => (
        <li key={entry.id} data-testid="activity-entry" data-kind={entry.kind} className="grid gap-0.5 border-t border-line py-2 first:border-t-0 first:pt-0">
          <p className="type-small">{entry.line}</p>
          <p className="type-mono text-11 text-muted">
            {whenLabel(entry.at)}
            {` · ${c.activityBy} ${entry.actor.kind === "you" ? c.activityByYou : entry.actor.kind === "relay" ? c.activityByRelay : (entry.actor.name ?? c.activityByRelay)}`}
          </p>
        </li>
      ))}
    </ol>
  );
}
