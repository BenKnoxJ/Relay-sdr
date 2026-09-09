"use client";

import { useEffect, useState } from "react";

import { benchCopy } from "@/lib/copy/bench";
import type { AutomaticCheck, RubricRow } from "@/lib/bench/rubric";
import { cn } from "@/lib/utils";

/**
 * The sign-off checklist: what the bench settled, and what you have to look at.
 *
 * The two halves are drawn apart on purpose. The automatic ones are facts —
 * the output is the shape the definition asks for, something really ran and it
 * cost something — and they arrive already decided, with what was observed
 * beside them. The rubric's own rows are a person looking at a screen, and the
 * bench must not tick those for you: a checklist that marks its own homework is
 * how an agent gets enabled on evidence nobody produced.
 *
 * Ticks live in `localStorage` and nowhere else. They are one developer's
 * working notes on one machine, not a record: sending them anywhere would make
 * them look like a sign-off, and the sign-off is Benny-san saying so.
 */
export function RubricChecklist({
  storageKey,
  automatic,
  rows,
}: {
  storageKey: string;
  automatic: AutomaticCheck[];
  rows: RubricRow[];
}) {
  const [ticked, setTicked] = useState<Record<string, boolean>>({});
  // Read after mount rather than during render: the server has no
  // `localStorage`, and reading it in the initial state would make the first
  // client render disagree with the server's.
  const [ready, setReady] = useState(false);

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(storageKey);
      setTicked(stored === null ? {} : (JSON.parse(stored) as Record<string, boolean>));
    } catch {
      // A corrupt or unavailable store is not worth a broken page: start blank.
      setTicked({});
    }
    setReady(true);
  }, [storageKey]);

  /**
   * A row's key, which is its number **and** its words.
   *
   * The number alone would hand a tick to whatever row 7 became after the
   * rubric was reworded or renumbered — a check nobody performed, showing as
   * performed, on the one screen whose job is to say what has been checked.
   */
  function keyOf(row: RubricRow): string {
    return `${row.n}:${row.check}`;
  }

  function toggle(id: string): void {
    setTicked((previous) => {
      const next = { ...previous, [id]: previous[id] !== true };
      try {
        window.localStorage.setItem(storageKey, JSON.stringify(next));
      } catch {
        // Private browsing, a full quota: the tick still shows for this visit.
      }
      return next;
    });
  }

  return (
    <div className="grid gap-4">
      <div>
        <h3 className="type-label mb-2">{benchCopy.automatic}</h3>
        <ul className="grid gap-1.5">
          {automatic.map((check) => (
            <li key={check.id} className="flex items-start gap-2.5">
              <span
                aria-hidden="true"
                className={cn(
                  "type-mono mt-0.5 shrink-0 text-11",
                  check.passed ? "text-action" : "text-warn",
                )}
              >
                {check.passed ? "✓" : "✕"}
              </span>
              <span className="type-body">
                {check.label}
                <span className="block text-12 text-muted">{check.detail}</span>
              </span>
            </li>
          ))}
        </ul>
      </div>

      <div>
        <h3 className="type-label mb-2">{benchCopy.manual}</h3>
        <ul className="grid gap-1.5">
          {rows.map((row) => (
            <li key={row.n}>
              <label className="flex items-start gap-2.5">
                <input
                  type="checkbox"
                  className="mt-1 shrink-0 accent-action"
                  checked={ready && ticked[keyOf(row)] === true}
                  onChange={() => toggle(keyOf(row))}
                />
                <span className="type-body">
                  {row.n}. {row.check}
                  <span className="block text-12 text-muted">{row.pass}</span>
                </span>
              </label>
            </li>
          ))}
        </ul>
        <p className="type-small mt-2 text-muted">{benchCopy.manualNote}</p>
      </div>
    </div>
  );
}
