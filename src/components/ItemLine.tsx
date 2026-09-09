import { planCopy } from "@/lib/copy/plan";
import { cn } from "@/lib/utils";

import type { Item } from "../../agents/research/output.schema";

/**
 * One line of a research pack: a confidence word, what was found, and where it
 * came from (signed tokens §4, signed mock §3b-ii).
 *
 * The prop type is the agent's own. `Item` is inferred from the zod schema in
 * `agents/_shared/item.schema.ts` and re-exported by
 * `agents/research/output.schema.ts`, which is the schema the research agent
 * writes against and the runtime validates with. There is deliberately no local
 * interface here: a component with its own idea of an item is a second contract
 * that drifts from the first one silently, and this is the plan conformance
 * guard the bench exists to make real.
 *
 * Two rules from the signed notes, both here rather than in a page:
 *
 *   * "Confidence is one of four words: strong, moderate, weak, a guess. Never
 *     a number." The schema stores `speculative`; `planCopy.confidence` is
 *     where it becomes the word a rep reads.
 *   * "Every line has a source you can open." The source line is built from the
 *     item's own evidence, so a line cannot be rendered without one — and an
 *     item with no urls is a guess, which says what it was inferred from
 *     instead. The schema already refuses any other combination.
 */

/** The colour a confidence word takes: the accent for strong, warn for a guess. */
function toneFor(confidence: Item["confidence"]): string {
  if (confidence === "strong") return "text-action";
  if (confidence === "speculative") return "text-warn";
  return "text-muted";
}

/**
 * Where the line came from, in one phrase.
 *
 * The hosts rather than the urls: a source line is read, not clicked, in a
 * read-only render, and five full urls on one line is not a source line. The
 * date is the source's own, not the read date — "3 Jul" in the mock is when the
 * thread was posted.
 */
export function sourceLine(item: Item): string {
  if (item.evidence.urls.length === 0) {
    return item.inferredFrom === undefined
      ? planCopy.noSource
      : `${planCopy.noSource}; inferred from ${item.inferredFrom}`;
  }
  const who = [item.speaker, item.role].filter((part) => part !== undefined).join(", ");
  const parts = [who, item.evidence.domains.join(", "), item.publishedAt].filter(
    (part) => part !== undefined && part !== "",
  );
  return parts.join(" · ");
}

export function ItemLine({ item, className }: { item: Item; className?: string }) {
  return (
    <div className={cn("flex items-start gap-2.5 py-1.5", className)}>
      <span className={cn("type-mono mt-0.5 shrink-0 text-11", toneFor(item.confidence))}>
        {planCopy.confidence[item.confidence]}
      </span>
      <span className="type-body">
        {item.quote === undefined ? item.text : `“${item.quote}”`}
        <span className="mt-0.5 block text-12 text-muted">{sourceLine(item)}</span>
      </span>
    </div>
  );
}
