"use client";

import { useActionState, useId } from "react";

import { SENTENCE_MAX } from "@/lib/shell";

import { PillButton } from "./PillButton";

/**
 * The one-line brief box: a pill with the primary button inside it (signed
 * mock, section 1b).
 *
 * It is the only door on Home on day one, and today it opens onto a sentence
 * and a line of copy — starting a campaign is slice 1. So it takes the action
 * as a prop rather than knowing anything about what happens next: the same
 * component serves the real Start when it lands.
 *
 * A real `<form>` and a real server action, not an `onClick`: it means the box
 * submits on Enter, the sentence is a named field rather than React state, and
 * the whole thing works before the client bundle has loaded. `useActionState`
 * gives back exactly one thing — the line to show underneath — which is all
 * the day-one contract has.
 */
export function BriefBox({
  label,
  placeholder,
  submitLabel,
  action,
}: {
  /** The accessible name of the box. The placeholder is an example, not a label. */
  label: string;
  placeholder: string;
  submitLabel: string;
  action: (previous: string | null, form: FormData) => Promise<string | null>;
}) {
  const [answer, submit, pending] = useActionState(action, null);
  const id = useId();

  return (
    <form action={submit}>
      <div className="flex items-center gap-2.5 rounded-pill border-control border-line bg-ground py-1.5 pl-card-rail pr-1.5 text-left">
        <label className="sr-only" htmlFor={id}>
          {label}
        </label>
        <input
          id={id}
          name="sentence"
          type="text"
          required
          maxLength={SENTENCE_MAX}
          autoComplete="off"
          placeholder={placeholder}
          className="type-body min-w-0 flex-1 bg-transparent text-ink outline-none placeholder:text-muted"
        />
        <PillButton type="submit" disabled={pending}>
          {submitLabel}
        </PillButton>
      </div>

      {/*
        The live region is always mounted, and empty until there is something
        to say. A `role="status"` element that appears at the same moment as
        its text is generally not announced at all — the region has to exist
        before the text lands in it. A rep who pressed Start and cannot see the
        line below the box has otherwise been told nothing.
      */}
      <p role="status" className={answer === null ? "sr-only" : "type-small mt-3 text-muted"}>
        {answer}
      </p>
    </form>
  );
}
