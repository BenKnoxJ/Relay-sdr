"use client";

import { useState } from "react";

import { Card } from "@/components/Card";
import { PillButton } from "@/components/PillButton";
import type { FindMoreView } from "@/lib/campaigns/types";
import { findMoreCopy } from "@/lib/copy/findMore";

/**
 * Find more people (P5b). Closed, one button. Open: 10, 20 or 30 people, what
 * the search is likely to use in credits, and what is left of the approved
 * search limit. When the estimate is more than what is left, the card says so
 * and the press approves a new limit, as Confirm does. The batch then goes
 * through the same review, Reveal, writing and Start outreach.
 */
export function FindMoreCard({
  view,
  pending,
  error,
  onFind,
}: {
  view: FindMoreView;
  pending: boolean;
  error: string | null;
  onFind: (howMany: 10 | 20 | 30, newCap: boolean) => void;
}) {
  const c = findMoreCopy;
  const [open, setOpen] = useState(false);
  const [howMany, setHowMany] = useState<10 | 20 | 30>(20);
  const option = view.options.find((each) => each.howMany === howMany) ?? view.options[0]!;

  return (
    <Card label={c.label}>
      <div data-testid="find-more-card">
        <p className="type-body max-w-measure">
          {c.batch} {view.batch} {c.intro}
        </p>
        {open ? (
          <div data-testid="find-more-form" className="mt-3">
            <fieldset>
              <legend className="type-label mb-1.5">{c.howMany}</legend>
              <div className="flex flex-wrap gap-2" role="radiogroup">
                {view.options.map((each) => (
                  <label
                    key={each.howMany}
                    className={`type-body flex cursor-pointer items-center gap-2 rounded-input border-control px-3 py-1.5 ${each.howMany === howMany ? "border-action text-ink" : "border-line text-muted"}`}
                  >
                    <input
                      type="radio"
                      name="find-more-how-many"
                      data-testid={`find-more-${each.howMany}`}
                      checked={each.howMany === howMany}
                      disabled={pending}
                      onChange={() => setHowMany(each.howMany)}
                      className="h-4 w-4 accent-action"
                    />
                    {each.howMany}
                  </label>
                ))}
              </div>
            </fieldset>
            <p data-testid="find-more-estimate" className="type-body mt-3">
              {c.about} {option.estimate} {c.searchCredits}
            </p>
            <p data-testid="find-more-left" className="type-small mt-1 text-muted">
              {view.remaining} {c.of} {view.cap} {c.leftOfCap}
            </p>
            {option.needsNewCap ? (
              <p data-testid="find-more-new-cap" className="type-small mt-1.5 max-w-measure text-warn">
                {c.capUsed} {view.newCap} {c.credits}.
              </p>
            ) : null}
            {view.sample ? <p className="type-small mt-1.5 text-muted">{c.sample}</p> : null}
          </div>
        ) : null}

        {error === null ? null : (
          <p role="alert" data-testid="find-more-error" className="type-small mt-2 text-warn">
            {error}
          </p>
        )}

        <div className="mt-3 flex flex-wrap items-center gap-2">
          {open ? (
            <>
              <PillButton data-testid="find-more-confirm" disabled={pending} onClick={() => onFind(howMany, option.needsNewCap)}>
                {pending ? c.finding : option.needsNewCap ? c.confirmNewCap : `${c.confirm} (${howMany})`}
              </PillButton>
              <PillButton data-testid="find-more-cancel" variant="outline" disabled={pending} onClick={() => setOpen(false)}>
                {c.cancel}
              </PillButton>
            </>
          ) : (
            <PillButton data-testid="find-more-open" variant="outline" disabled={pending} onClick={() => setOpen(true)}>
              {c.open}
            </PillButton>
          )}
        </div>
      </div>
    </Card>
  );
}
