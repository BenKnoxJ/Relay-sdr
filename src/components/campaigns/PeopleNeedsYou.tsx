"use client";

import { useState } from "react";

import { Card } from "@/components/Card";
import { PillButton } from "@/components/PillButton";
import { TextLink } from "@/components/TextButton";
import type { PeopleNeedsYouView } from "@/lib/campaigns/types";
import { campaignsCopy } from "@/lib/copy/campaigns";

/**
 * Finding people needs the rep (lead gen v2.1 §11): the reason in words and
 * what can be done. A choose-an-industry stop offers research's term's
 * closest matches as plain words, never provider ids, and searches again
 * with the one chosen; nothing is widened on the rep's behalf. Try again is
 * the page's header action; Edit brief is here too, because the card names
 * it (final MVP pass).
 */
export function PeopleNeedsYou({
  view,
  canRetry,
  spent,
  editHref,
  onChoose,
}: {
  view: PeopleNeedsYouView;
  canRetry: boolean;
  spent: boolean;
  editHref?: string;
  onChoose?: (label: string) => Promise<string | null>;
}) {
  const c = campaignsCopy;
  const [picked, setPicked] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const search = async () => {
    if (onChoose === undefined || picked === null || pending) return;
    setPending(true);
    setError(null);
    try {
      const failed = await onChoose(picked);
      if (failed !== null) setError(failed);
    } catch {
      setError(c.cannotChange);
    }
    setPending(false);
  };

  return (
    <Card label={c.peopleNeedsYouLabel}>
      <div data-testid="people-needs-you">
      <p data-testid="people-reason" className="type-body max-w-measure text-warn">
        {view.line}
      </p>
      {view.choices.length > 0 && onChoose !== undefined ? (
        <fieldset className="mt-2">
          <legend className="type-small text-muted">{c.haltChooseHint}</legend>
          <div className="mt-1.5 grid gap-1">
            {view.choices.map((choice) => (
              <label key={choice} className="type-small flex items-center gap-2">
                <input type="radio" name="industry" value={choice} checked={picked === choice} onChange={() => setPicked(choice)} />
                {choice}
              </label>
            ))}
          </div>
          <PillButton className="mt-2" disabled={picked === null || pending} onClick={() => void search()}>
            {pending ? c.actionSearching : c.actionSearchWith}
          </PillButton>
        </fieldset>
      ) : (
        <p className="type-small mt-1 text-muted">{canRetry ? c.haltNextRetry : c.haltNextEdit}</p>
      )}
      {editHref === undefined ? null : (
        <TextLink href={editHref} data-testid="people-edit" className="mt-3">
          {c.editBrief}
        </TextLink>
      )}
      {spent ? (
        <p data-testid="edit-warning" className="type-small mt-1.5 text-muted">
          {c.editWarning}
        </p>
      ) : null}
      {error === null ? null : (
        <p role="alert" data-testid="choose-error" className="type-small mt-1.5 text-warn">
          {error}
        </p>
      )}
      </div>
    </Card>
  );
}
