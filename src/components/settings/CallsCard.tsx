"use client";

import { useId, useState } from "react";

import { Card } from "@/components/Card";
import { callsCopy, settingsCopy } from "@/lib/copy/settings";
import { getProfile, saveProfile, type RepProfile } from "@/lib/fixtures/repProfile";
import { cn } from "@/lib/utils";

import { SaveLine } from "./SaveLine";

/**
 * The Calls card (master doc §23.1f, mock section 5): one toggle, include a
 * day-3 call in new campaigns by default. Start (§23.1d) reads it as the
 * default for its Calls chip and the rep can still turn Calls off there.
 *
 * A real `role="switch"` button: it has a name (the sentence beside it), a
 * state (`aria-checked`) and a focus ring. A switch has no blur to save on,
 * so it saves on change, and the same quiet "Saved" says so.
 */
export function CallsCard({ initial }: { initial?: RepProfile }) {
  const [on, setOn] = useState(() => (initial ?? getProfile()).callByDefault);
  const [line, setLine] = useState<string | null>(null);
  const id = useId();

  function toggle() {
    const next = !on;
    saveProfile({ callByDefault: next });
    setOn(next);
    setLine(settingsCopy.saved);
  }

  return (
    <Card label={settingsCopy.calls} aside={<SaveLine line={line} />}>
      <div className="flex items-center justify-between gap-3">
        <span id={id} className="type-body text-ink">
          {callsCopy.toggle}
        </span>
        <button
          type="button"
          role="switch"
          aria-checked={on}
          aria-labelledby={id}
          onClick={toggle}
          className={cn(
            "relative inline-flex h-6 w-11 shrink-0 items-center rounded-pill border-control",
            "transition-opacity duration-micro ease-standard hover:opacity-90",
            "focus-visible:outline-none focus-visible:ring-2",
            on ? "border-transparent bg-action" : "border-line bg-ground",
          )}
        >
          <span
            aria-hidden="true"
            className={cn(
              "absolute h-4 w-4 rounded-pill transition-transform duration-micro ease-standard",
              on ? "translate-x-6 bg-on-action" : "translate-x-1 bg-muted",
            )}
          />
          <span className="sr-only">{on ? callsCopy.on : callsCopy.off}</span>
        </button>
      </div>
      <p className="type-small mt-1.5 text-muted">{callsCopy.note}</p>
    </Card>
  );
}
