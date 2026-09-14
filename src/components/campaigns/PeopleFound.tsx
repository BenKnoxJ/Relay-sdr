"use client";

import { useState } from "react";

import { Card } from "@/components/Card";
import { Chip } from "@/components/Chip";
import type { AccountView, FoundPersonView, PeopleFoundView, ReviewView } from "@/lib/campaigns/types";
import { campaignsCopy } from "@/lib/copy/campaigns";
import { cn } from "@/lib/utils";

/**
 * Reviewing people (lead gen v2.2 §9a): accounts first, the people Relay
 * chose nested under each, and the rep's keep or drop on every one.
 *
 * Each account says how many people it has, which roles they cover and why
 * it is in this campaign, in lines Relay can stand behind: the plan's own
 * search, and a firm research named. Each person says the role they play and,
 * as why they fit, what research says that role needs. No email, no provider
 * id. Reveal emails is still the page's header action and is not pressable;
 * the estimate under the list counts kept people only.
 */

type Review = (personId: string, scope: "person" | "account", decision: "kept" | "dropped") => Promise<string | null>;

const REVIEW_CHIP: Record<ReviewView, { tone: "default" | "ok" | "warn"; word: string }> = {
  pending: { tone: "default", word: campaignsCopy.reviewPending },
  kept: { tone: "ok", word: campaignsCopy.reviewKept },
  dropped: { tone: "warn", word: campaignsCopy.reviewDropped },
};

function ReviewButton({ label, pressed, disabled, onPress, testId }: { label: string; pressed: boolean; disabled: boolean; onPress: () => void; testId: string }) {
  return (
    <button
      type="button"
      data-testid={testId}
      aria-pressed={pressed}
      disabled={disabled}
      onClick={onPress}
      className={cn(
        "type-small inline-flex min-h-8 items-center rounded-pill border px-3 font-semibold focus-visible:outline-none focus-visible:ring-2 disabled:opacity-60",
        pressed ? "border-transparent bg-action text-on-action" : "border-line text-action",
      )}
    >
      {label}
    </button>
  );
}

function Person({ person, roles, busy, press }: { person: FoundPersonView; roles: boolean; busy: boolean; press?: (decision: "kept" | "dropped") => void }) {
  const c = campaignsCopy;
  const chip = REVIEW_CHIP[person.review];
  return (
    <li data-testid="found-person" data-review={person.review} className="flex flex-wrap items-start gap-3">
      <span className="min-w-0 flex-1">
        <b className="type-name block text-14">
          {person.name} · {person.title}
        </b>
        {person.city === null ? null : <span className="type-small block text-muted">{person.city}</span>}
        <span className="mt-1 flex flex-wrap items-center gap-1.5">
          {roles ? (
            <Chip tone={person.role === null ? "default" : "ok"}>
              <span data-testid="role-chip">{person.role === null ? c.relatedRole : c.roleParts[person.role]}</span>
            </Chip>
          ) : null}
          {person.reused ? <Chip tone="ok">{c.peopleReusedChip}</Chip> : null}
          <Chip tone={chip.tone}>
            <span data-testid="review-chip">{chip.word}</span>
          </Chip>
        </span>
        <span data-testid="why-fits" className="type-small mt-1 block">
          {roles ? (
            <>
              <span className="text-muted">{c.whyFits}</span> {person.needs ?? c.relatedFits}
            </>
          ) : (
            person.whyPicked
          )}
        </span>
      </span>
      {press === undefined ? null : (
        <span className="flex shrink-0 gap-1.5">
          <ReviewButton testId="keep" label={c.reviewKeep} pressed={person.review === "kept"} disabled={busy} onPress={() => press("kept")} />
          <ReviewButton testId="drop" label={c.reviewDrop} pressed={person.review === "dropped"} disabled={busy} onPress={() => press("dropped")} />
        </span>
      )}
    </li>
  );
}

function Account({ account, roles, busy, press }: { account: AccountView; roles: boolean; busy: boolean; press?: Review }) {
  const c = campaignsCopy;
  const everyoneDropped = account.people.every((person) => person.review === "dropped");
  return (
    <li data-testid="found-account" className="min-w-0 rounded-input border border-line p-3 [overflow-wrap:anywhere]">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <h3 data-testid="account-name" className="type-name text-15">
            {account.company}
          </h3>
          {account.domain === null ? null : <p className="type-small text-muted">{account.domain}</p>}
          <p data-testid="account-coverage" className="type-small mt-0.5">
            {account.people.length} {account.people.length === 1 ? c.accountPerson : c.accountPeople}
            {roles && account.parts.length > 0 ? ` · ${account.parts.map((part) => c.roleParts[part]).join(", ")}` : ""}
          </p>
          <p data-testid="account-fit" className="type-small text-muted">
            {account.fit}
          </p>
        </div>
        {press === undefined || everyoneDropped ? null : (
          <ReviewButton testId="drop-account" label={c.reviewDropAccount} pressed={false} disabled={busy} onPress={() => void press(account.personId, "account", "dropped")} />
        )}
      </div>
      <ul className="mt-2.5 grid gap-2.5 border-t border-line pt-2.5">
        {account.people.map((person) => (
          <Person
            key={person.id}
            person={person}
            roles={roles}
            busy={busy}
            {...(press === undefined ? {} : { press: (decision: "kept" | "dropped") => void press(person.id, "person", decision) })}
          />
        ))}
      </ul>
    </li>
  );
}

export function PeopleFound({ view, editHref, spent, onReview }: { view: PeopleFoundView; editHref?: string; spent: boolean; onReview?: Review }) {
  const c = campaignsCopy;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const multiRole = view.accounts.filter((account) => account.parts.length > 1).length;

  const press: Review | undefined =
    onReview === undefined
      ? undefined
      : async (personId, scope, decision) => {
          if (busy) return null;
          setBusy(true);
          setError(null);
          try {
            const line = await onReview(personId, scope, decision);
            if (line !== null) setError(line);
            return line;
          } catch {
            setError(c.cannotChange);
            return c.cannotChange;
          } finally {
            setBusy(false);
          }
        };

  return (
    <Card label={c.peopleFoundLabel}>
      <div data-testid="people-found">
        <p data-testid="found-count" className="type-name">
          {view.found.n} {c.peopleFoundOf} {view.found.ofM}
        </p>
        <p data-testid="accounts-summary" className="type-small">
          {view.found.n} {c.accountsPeopleAt} {view.accounts.length} {c.accountsWord}
          {view.roles && multiRole > 0 ? ` · ${multiRole} ${c.accountsMultiRole}` : ""}
        </p>
        <p className="type-small text-muted">
          {c.peopleFoundFor} {view.groupName}
        </p>
        {view.shortfall === null ? null : (
          <p data-testid="shortfall" className="type-small mt-1.5 text-warn">
            {view.shortfall === "cap_reached" ? c.shortfallCapReached : view.shortfall === "fewer_strong_matches" ? c.shortfallFewerStrong : c.shortfallNoMore}
          </p>
        )}
        <p data-testid="review-counts" className="type-small mt-1.5 text-muted">
          {view.review.kept} {c.reviewCountKept} · {view.review.dropped} {c.reviewCountDropped} · {view.review.pending} {c.reviewCountPending}
        </p>
        {error === null ? null : (
          <p role="alert" data-testid="review-error" className="type-small mt-1.5 text-warn">
            {error}
          </p>
        )}

        <ol className="mt-3 grid gap-3">
          {view.accounts.map((account) => (
            <Account key={account.personId} account={account} roles={view.roles} busy={busy} {...(press === undefined ? {} : { press })} />
          ))}
        </ol>

        <div className="mt-3 grid gap-1 border-t border-line pt-3">
          {view.onHold > 0 ? (
            <p data-testid="on-hold" className="type-small text-muted">
              {view.onHold} {c.peopleHeldBack}
            </p>
          ) : null}
          <p data-testid="spend-line" className="type-small">
            {c.spendUsed} {view.spend.charged} {c.spendOf} {view.spend.cap} {c.spendCredits}
            {view.spend.reserved > 0 ? ` ${view.spend.reserved} ${c.spendHeld}` : ""}
          </p>
          {view.sample ? (
            <p data-testid="spend-sample" className="type-small text-warn">
              {c.spendSample}
            </p>
          ) : null}
          <p data-testid="reveal-estimate" className="type-small text-muted">
            {view.revealEstimate.kept === 0 ? (
              c.revealNoneKept
            ) : (
              <>
                {c.revealKeptAbout} {view.revealEstimate.credits} {c.revealCredits}
                {view.revealEstimate.reused > 0 ? ` ${view.revealEstimate.reused} ${c.revealReused}` : ""}
              </>
            )}
          </p>
          {editHref !== undefined && spent ? (
            <p data-testid="edit-warning" className="type-small text-muted">
              {c.editWarning}
            </p>
          ) : null}
        </div>
      </div>
    </Card>
  );
}
