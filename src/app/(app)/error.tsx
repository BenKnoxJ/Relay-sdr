"use client";

import { Card } from "@/components/Card";
import { PillButton } from "@/components/PillButton";
import { shellCopy } from "@/lib/copy/shell";

/**
 * Where a fault under the shell lands (Next's segment error boundary).
 *
 * A client component because Next requires it. It never shows the fault
 * itself: a driver's message on a rep's screen is not copy, and the layout
 * already keeps the two refusals that are. What it says is the one thing a
 * rep needs to know before pressing anything, that nothing was bought or
 * sent, and the one thing they can do, which is try the page again.
 *
 * `reset()` asks Next to re-render the segment; it is the honest Reload,
 * since the fault may have been a moment's outage and the rep's place in the
 * app is kept.
 */
export default function ShellError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <Card className="mx-auto max-w-measure">
      <h1 className="type-heading mb-1.5">{shellCopy.errorHeading}</h1>
      <p className="type-body mb-4 text-muted">{shellCopy.errorBody}</p>
      <PillButton onClick={() => reset()}>{shellCopy.reload}</PillButton>
    </Card>
  );
}
