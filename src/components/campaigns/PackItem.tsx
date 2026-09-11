import type { Item, Phrase } from "../../../agents/_shared/item.schema";

import { campaignsCopy } from "@/lib/copy/campaigns";
import { cn } from "@/lib/utils";

/**
 * One line of research, with its source and its confidence word.
 *
 * The rule this component exists to keep (§23.1c): **every** rendered item
 * carries a source and a confidence word, and the word is one of four English
 * ones, never a number. There is no branch here that renders an item without
 * them, so an item that lacks either cannot reach a screen quietly. It cannot
 * reach one loudly either: the contract refuses it first, and
 * `src/lib/fixtures/campaigns.ts` parses the pack at module load.
 */

/** The screen's four words. `speculative` is the only one that is not itself. */
export function confidenceWord(confidence: Item["confidence"]): string {
  switch (confidence) {
    case "strong":
      return campaignsCopy.confidenceStrong;
    case "moderate":
      return campaignsCopy.confidenceModerate;
    case "weak":
      return campaignsCopy.confidenceWeak;
    case "speculative":
      return campaignsCopy.confidenceGuess;
  }
}

/**
 * The host of a url, for the "who said it" half of the source line.
 *
 * Three lines rather than an import of `hostOf` from
 * `agents/_shared/item.schema`: that module builds its zod schemas at load, so
 * importing it here would pull zod and every schema in the research contract
 * into the browser bundle to spell one hostname.
 */
export function sourceHost(url: string): string {
  try {
    return new URL(url).host.toLowerCase().replace(/^www\./, "");
  } catch {
    return url;
  }
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * An ISO date as "2 Apr 2026".
 *
 * Formatted from the string's own digits and not through `Intl`: the same
 * markup is rendered on the server and in the browser, and a formatter that
 * reads the reader's locale or clock gives two different answers and a
 * hydration mismatch.
 */
export function shortDate(iso: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (match === null) return null;
  const month = MONTHS[Number(match[2]) - 1];
  if (month === undefined) return null;
  return `${Number(match[3])} ${month} ${match[1]}`;
}

/** The grey line under an item: where it came from, and when it was said. */
function SourceLine({ item }: { item: Item }) {
  const url = item.evidence.urls[0];
  const when = item.publishedAt === undefined ? null : shortDate(item.publishedAt);

  if (url === undefined) {
    return (
      <span className="type-small block text-muted">
        {item.inferredFrom === undefined
          ? campaignsCopy.noSource
          : `${campaignsCopy.noSourceFrom} ${item.inferredFrom}`}
      </span>
    );
  }

  return (
    <span className="type-small block text-muted">
      <a
        href={url}
        target="_blank"
        rel="noreferrer"
        className="underline focus-visible:outline-none focus-visible:ring-2"
      >
        {sourceHost(url)}
      </a>
      {item.evidence.urls.length > 1 ? ` +${item.evidence.urls.length - 1}` : null}
      {when === null ? null : `${campaignsCopy.noteJoin}${when}`}
    </span>
  );
}

/**
 * The confidence pill. `a guess` is the one that reads in the warn colour,
 * because it is the one the rep must not mistake for a finding.
 */
function ConfidenceChip({ confidence }: { confidence: Item["confidence"] }) {
  return (
    <span
      data-testid="confidence"
      className={cn(
        "type-mono inline-flex shrink-0 items-center rounded-pill px-2 py-0.5 text-11",
        confidence === "strong"
          ? "bg-soft text-action"
          : confidence === "speculative"
            ? "bg-warn-bg text-warn"
            : "bg-ground text-muted",
      )}
    >
      {confidenceWord(confidence)}
    </span>
  );
}

export function PackItem({ item, quoteFirst = false }: { item: Item; quoteFirst?: boolean }) {
  const lead = quoteFirst && item.quote !== undefined ? `“${item.quote}”` : item.text;

  return (
    <div data-testid="pack-item" className="flex items-start gap-2.5 py-1.5">
      <ConfidenceChip confidence={item.confidence} />
      <span className="type-small">
        {lead}
        <SourceLine item={item} />
      </span>
    </div>
  );
}

/** A phrase: what to say, what not to say, and the same source line. */
export function PackPhrase({ phrase }: { phrase: Phrase }) {
  return (
    <div data-testid="pack-item" className="flex items-start gap-2.5 py-1.5">
      <ConfidenceChip confidence={phrase.confidence} />
      <span className="type-small">
        <span className="font-semibold">{campaignsCopy.sayThis}</span> “{phrase.say}”
        {phrase.notThis === undefined ? null : (
          <>
            {campaignsCopy.noteJoin}
            <span className="font-semibold">{campaignsCopy.notThis}</span> “{phrase.notThis}”
          </>
        )}
        <SourceLine item={phrase} />
      </span>
    </div>
  );
}
