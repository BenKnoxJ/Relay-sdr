"use client";

import { useId, useState } from "react";

import { PillButton } from "@/components/PillButton";
import { CALL_OUTCOMES, inboxCopy, type CallOutcome } from "@/lib/copy/inbox";

/**
 * The four outcomes a call can have (master doc §23.1b): spoke, voicemail, no
 * answer, wrong number. Iterated from the signed vocabulary, like the labels.
 *
 * Three of them are one click. Spoke asks for one line of notes first (mock
 * 2c, "only after Spoke"): the row gives way to a box and a Log it button,
 * and Enter in the box is the same as the button. The notes are optional —
 * a rep who spoke and has nothing to add logs it empty — so the box never
 * blocks the outcome.
 *
 * Spoke is the primary and the other three are outlines; when the box is
 * open, Log it is the primary and Spoke has gone. One accent per card either
 * way (§21).
 */
export function OutcomeRow({
  onChoose,
}: {
  onChoose: (outcome: CallOutcome, notes?: string) => void;
}) {
  const [spoke, setSpoke] = useState(false);
  const [notes, setNotes] = useState("");
  const id = useId();

  if (spoke) {
    return (
      <form
        className="flex items-center gap-2.5"
        onSubmit={(event) => {
          event.preventDefault();
          onChoose("spoke", notes.trim() === "" ? undefined : notes.trim());
        }}
      >
        <label className="sr-only" htmlFor={id}>
          {inboxCopy.notesLabel}
        </label>
        <input
          id={id}
          name="notes"
          autoFocus
          autoComplete="off"
          value={notes}
          placeholder={inboxCopy.notesPlaceholder}
          onChange={(event) => setNotes(event.currentTarget.value)}
          className="type-small min-w-0 flex-1 rounded-input border-control border-line bg-panel px-3.5 py-2.5 text-ink outline-none placeholder:text-muted focus-visible:ring-2"
        />
        <PillButton type="submit">{inboxCopy.notesDone}</PillButton>
      </form>
    );
  }

  return (
    <div role="group" aria-label={inboxCopy.logOutcome} className="flex flex-wrap gap-chips">
      {CALL_OUTCOMES.map((outcome) => (
        <PillButton
          key={outcome}
          data-testid="call-outcome"
          variant={outcome === "spoke" ? "primary" : "outline"}
          onClick={() => (outcome === "spoke" ? setSpoke(true) : onChoose(outcome))}
        >
          {inboxCopy.callOutcome[outcome]}
        </PillButton>
      ))}
    </div>
  );
}
