"use client";

import { useActionState, useId, useRef } from "react";

import { mailboxCopy } from "@/lib/copy/settings";

/**
 * The daily cap, which saves on blur (§23.1f: "Saves on blur with a quiet
 * 'Saved'").
 *
 * A real `<form>` and a real server action, like `BriefBox`: the value is a
 * named field rather than React state, so it works before the client bundle
 * lands and a rep who tabs straight past it changes nothing.
 *
 * Save on blur is `requestSubmit()` from `onBlur`, guarded on the value having
 * actually changed. Without the guard, tabbing through the field posts a write
 * — and a write here is an Event, so the audit record would fill with cap
 * changes that changed no cap.
 *
 * The guard compares against what was last submitted from this field, held in a
 * ref, and not against the `cap` prop. The prop is the value the server
 * rendered with, and a rep who lowers the cap and then puts the original number
 * back is making a real change that a comparison against the prop would read as
 * no change at all.
 *
 * The ceiling is `max` on the input as well as a check in the repository. The
 * attribute is a courtesy to the rep, not a control: it is client-supplied, and
 * `setDailyCap` refuses anything above the ceiling regardless.
 */
export function DailyCapField({
  cap,
  adminCap,
  note,
  action,
}: {
  cap: number;
  adminCap: number;
  /** "of 10 set by your admin", assembled by the router from the copy file. */
  note: string;
  action: (previous: string | null, form: FormData) => Promise<string | null>;
}) {
  const [answer, submit, pending] = useActionState(action, null);
  const id = useId();
  const lastSubmitted = useRef(String(cap));

  function onBlur(event: React.FocusEvent<HTMLInputElement>) {
    if (pending) return;
    const value = event.currentTarget.value;
    if (value === lastSubmitted.current) return;
    lastSubmitted.current = value;
    event.currentTarget.form?.requestSubmit();
  }

  return (
    <form action={submit} className="flex items-baseline gap-2.5">
      <label className="type-small w-[136px] shrink-0 text-muted" htmlFor={id}>
        {mailboxCopy.capLabel}
      </label>

      <input
        id={id}
        name="cap"
        type="number"
        inputMode="numeric"
        min={1}
        max={adminCap}
        defaultValue={cap}
        onBlur={onBlur}
        disabled={pending}
        className="type-body w-16 rounded-input border-control border-line bg-ground px-2 py-1 text-ink outline-none focus-visible:ring-2"
      />

      <span className="type-small text-muted">{note}</span>

      {/*
        Always mounted and empty until there is something to say — a
        `role="status"` that appears at the same moment as its text is often
        not announced at all. It carries the quiet "Saved" and the refusal
        alike, because both are the same question answered.
      */}
      <span role="status" className={answer === null ? "sr-only" : "type-small text-muted"}>
        {answer}
      </span>
    </form>
  );
}
