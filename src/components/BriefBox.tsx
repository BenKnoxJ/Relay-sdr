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
 * A real `<form>` and a real server action, not an `onClick`: it means the
 * sentence is a named field rather than React state, and the whole thing works
 * before the client bundle has loaded. `useActionState` gives back exactly one
 * thing — the line to show underneath — which is all the day-one contract has.
 *
 * A `<textarea>` rather than an `<input>`, because the signed mock draws the
 * example sentence over two lines and a single line clips two of its three
 * clauses ("…offer c"). The placeholder is a teaching device — it is the shape
 * of a brief, and two thirds of it hidden teaches the wrong shape.
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

  /**
   * A textarea takes Enter as a newline, and an input took it as submit. The
   * box is one control with one button beside it, so Enter has to keep meaning
   * Start or the control a rep already reached for silently changed meaning;
   * Shift+Enter is the newline, which is the convention every chat box uses.
   *
   * `isComposing` is the one that is not obvious. An IME ends a Japanese or
   * Chinese candidate with Enter, and reading that as submit sends a
   * half-typed brief.
   */
  function onKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    // `disabled` on the button stops the mouse and nothing else — Enter never
    // goes near it. Without this, a rep leaning on the key submits once per
    // press, which is a duplicate campaign the moment Start does anything.
    if (pending) return;
    event.currentTarget.form?.requestSubmit();
  }

  return (
    <form action={submit}>
      {/*
        The ring goes on the pill, not on the field (WCAG 2.4.7): the field is
        borderless inside the pill, so a ring drawn on it would be painted
        inside the pill's own border, and the pill is the control a rep sees.

        `focus-within`, which is what the design review prescribed. The
        narrower `has-[textarea:focus]` was built and then backed out: in a
        headless window `:focus` does not match at all (only `:focus-within`
        does), so the rule never fires in the conformance capture and the one
        blocking accessibility fix on this branch could not be shown to work.
        A focus indicator that cannot be demonstrated is not evidence.

        The cost is that tabbing to Start rings the pill as well as the button
        — two rings, one focused control. Flagged for Neon rather than decided
        here: which ring gives way is a design call, and the fix if it is the
        pill's is a token-level focus treatment, not a class on this element.

        `focus-within` has no `-visible` form, which is right here: a mouse
        click leaves the ring up until focus moves, and for a text box that is
        the truth — it is where typing goes.
      */}
      <div
        data-testid="brief-pill"
        className="flex items-center gap-2.5 rounded-pill border-control border-line bg-ground py-1.5 pl-card-rail pr-1.5 text-left focus-within:ring-2"
      >
        <label className="sr-only" htmlFor={id}>
          {label}
        </label>
        <textarea
          id={id}
          name="sentence"
          rows={2}
          required
          maxLength={SENTENCE_MAX}
          autoComplete="off"
          placeholder={placeholder}
          onKeyDown={onKeyDown}
          className="type-body min-w-0 flex-1 resize-none bg-transparent py-1 text-ink outline-none placeholder:text-muted"
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
