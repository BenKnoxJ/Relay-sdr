"use client";

import { useState } from "react";

import { Card } from "@/components/Card";
import { PillButton } from "@/components/PillButton";
import type { WidenChoice } from "@/lib/campaigns/types";
import { campaignsCopy } from "@/lib/copy/campaigns";
import { cn } from "@/lib/utils";
import type { Item } from "../../../agents/research/output.schema";

import { PackItem } from "./PackItem";

/**
 * The insufficient-evidence stop (§23.1c, mock 3c): what research did find,
 * and the ways to widen. Nothing is spent.
 *
 * The options are research's own — one to three genuine ways to widen, on
 * region, size, sector or role (research v3.2, §10 note 28). They are not
 * written here and they are not a fixed list. Research's text is shown as it
 * wrote it; what the card adds is a heading for the dimension, numbered when
 * two options widen the same thing, and the line the brief would read after
 * each (`becomes`), so two options with similar prose are two different
 * changes on screen as well as in the brief.
 *
 * With `onWiden`, the options are a choice: one is chosen, and "Look again
 * with this" asks for the widened brief's research (orchestrator A1, item 4).
 * An option that no longer fits the brief is drawn and cannot be chosen.
 * Without it (the samples), they are a list, and the page's own action widens.
 */
export function WidenCard({
  reason,
  found,
  choices,
  onWiden,
}: {
  /** Why research stopped, in research's own words (the stop's `reason`). */
  reason: string;
  /** The evidence the stop cites, resolved from the pack's m00 and m01 items by the caller. */
  found: Item[];
  choices: WidenChoice[];
  /** Asks for the chosen option. Resolves to a line to show, or null when it landed. */
  onWiden?: (optionIndex: number) => Promise<string | null>;
}) {
  const [chosen, setChosen] = useState<number | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const widen = async () => {
    if (onWiden === undefined || chosen === null || pending) return;
    setPending(true);
    setError(null);
    try {
      const line = await onWiden(chosen);
      if (line === null) return;
      setError(line);
    } catch {
      setError(campaignsCopy.cannotChange);
    }
    setPending(false);
  };

  return (
    <Card className="max-w-[760px]">
      <p className="type-small mb-3 rounded-input bg-warn-bg px-3 py-2.5 text-warn">
        {campaignsCopy.stopBanner}
      </p>
      <p data-testid="stop-reason" className="type-body mb-4">
        {reason}
      </p>

      <div className="grid gap-grid wide:grid-cols-2">
        <div>
          <h3 className="type-label mb-1.5">{campaignsCopy.stopFound}</h3>
          {found.map((item) => (
            <PackItem key={item.id} item={item} />
          ))}
        </div>

        <fieldset disabled={pending} className="min-w-0">
          <legend className="type-label mb-1.5">{campaignsCopy.stopHelp}</legend>
          <ul className="grid gap-chips">
            {/*
              Keyed by position, not by dimension: two options can widen the
              same dimension two ways (brief C's stop offers two regions), and
              the position is what a choice names.
            */}
            {choices.map((choice) => {
              const body = (
                <>
                  <span data-testid="widen-heading" className="type-small block font-semibold">
                    {choice.heading}
                  </span>
                  <span className="type-small block text-muted">{choice.text}</span>
                  {choice.becomes === null ? null : (
                    <span data-testid="widen-becomes" className="type-small mt-1 block">
                      {choice.becomes}
                    </span>
                  )}
                  {choice.usable ? null : (
                    <span className="type-small mt-1 block text-warn">{campaignsCopy.widenUnusable}</span>
                  )}
                </>
              );
              if (onWiden === undefined) {
                return (
                  <li key={choice.index} data-testid="widening" className="py-1.5">
                    {body}
                  </li>
                );
              }
              const on = chosen === choice.index;
              return (
                <li key={choice.index} data-testid="widening">
                  <label
                    className={cn(
                      "flex gap-2.5 rounded-input border px-3 py-2.5",
                      "transition-colors duration-micro ease-standard",
                      "has-[:focus-visible]:ring-2",
                      choice.usable ? "cursor-pointer" : "cursor-not-allowed opacity-60",
                      on ? "border-action bg-soft" : "border-line bg-panel",
                    )}
                  >
                    <input
                      type="radio"
                      name="widening"
                      value={choice.index}
                      checked={on}
                      disabled={!choice.usable}
                      onChange={() => {
                        setChosen(choice.index);
                        setError(null);
                      }}
                      className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--relay-action)] focus-visible:outline-none"
                    />
                    <span className="min-w-0">{body}</span>
                  </label>
                </li>
              );
            })}
          </ul>

          {onWiden === undefined ? null : (
            <PillButton
              data-testid="widen-submit"
              className="mt-3"
              disabled={chosen === null || pending}
              onClick={() => void widen()}
            >
              {pending ? campaignsCopy.widenSubmitting : campaignsCopy.widenSubmit}
            </PillButton>
          )}
          <p data-testid="widen-note" className="type-small mt-2 text-muted">
            {campaignsCopy.stopChooseOne}
          </p>
          {error === null ? null : (
            <p role="alert" data-testid="widen-error" className="type-small mt-2 text-warn">
              {error}
            </p>
          )}
        </fieldset>
      </div>
    </Card>
  );
}
