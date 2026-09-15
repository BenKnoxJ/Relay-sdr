import type { ActivityEntry } from "@/lib/campaigns/types";
import { campaignsCopy } from "@/lib/copy/campaigns";

/**
 * What has happened to this campaign, newest first (final MVP pass): one
 * line per Event, with when and who. The rail's fourth tab, in place of
 * the six questions. Every line is a thing that happened; a count of
 * work that has not happened is never drawn here.
 */
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
        <li key={entry.id} data-testid="activity-entry" className="grid gap-0.5 border-t border-line py-2 first:border-t-0 first:pt-0">
          <p className="type-small">{entry.line}</p>
          {entry.detail === null ? null : <p className="type-small text-12 text-muted">{entry.detail}</p>}
          <p className="type-mono text-11 text-muted">
            {entry.when}
            {entry.by === null ? "" : ` · ${c.activityBy} ${entry.by}`}
          </p>
        </li>
      ))}
    </ol>
  );
}
