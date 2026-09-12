import type { Campaign } from "@/lib/campaigns/types";
import { campaignsCopy } from "@/lib/copy/campaigns";

/**
 * Progress: five counts and nothing else (§23.1c, "counts only").
 *
 * No bar, no percentage, no rate. The signed mock draws five numbers with a
 * word under each, and a progress bar over them would be Relay claiming to
 * know how far through the campaign is, which it does not. Drawn only once
 * people have been found; before that the page says so in words.
 */
export function ProgressCounts({
  progress,
  note,
}: {
  progress: NonNullable<Campaign["progress"]>;
  note?: string;
}) {
  const counts: [string, number][] = [
    [campaignsCopy.progressFound, progress.found],
    [campaignsCopy.progressDrafted, progress.drafted],
    [campaignsCopy.progressApproved, progress.approved],
    [campaignsCopy.progressSent, progress.sent],
    [campaignsCopy.progressReplied, progress.replied],
  ];

  return (
    <>
      <dl className="grid grid-cols-5 gap-2">
        {counts.map(([word, count]) => (
          <div
            key={word}
            data-testid="progress-count"
            /*
              The word is the term and the number is its definition, so the
              word comes first in the markup and the column is reversed to put
              the number on top. Written the other way round it reads out as
              "twenty: found", which is backwards.
            */
            className="flex flex-col-reverse rounded-input border border-line px-3 py-2.5 text-center"
          >
            <dt className="type-small text-muted">{word}</dt>
            <dd className="type-mono-big">{count}</dd>
          </div>
        ))}
      </dl>
      {note === undefined ? null : <p className="type-small mt-3 text-muted">{note}</p>}
    </>
  );
}
