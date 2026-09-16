"use client";

import { useState } from "react";

import { Card } from "@/components/Card";
import { TextButton } from "@/components/TextButton";
import { ToggleChip } from "@/components/ToggleChip";
import type { AccountView, BuyerRoleView, FoundPersonView, PeopleFoundView, ReviewView } from "@/lib/campaigns/types";
import { campaignsCopy } from "@/lib/copy/campaigns";
import { cn } from "@/lib/utils";

/**
 * Reviewing people (lead gen v2.2 §9a), then People ready (v2.1 §11):
 * accounts first, the people Relay chose nested under each.
 *
 * Reviewing (final MVP pass): the accounts with someone still to decide come
 * first; an account whose every person is decided folds to one line, a
 * press away from being changed. Each person is one row: name and title,
 * the role they matched as a word, what Relay holds on them as one quiet
 * line, and Keep or Drop. Nothing is boxed inside the card: rows are
 * divided by hairlines, and the one accent is the decision taken.
 *
 * After Reveal emails: only the kept people, each with their email when it is
 * ready and usable, or one line on why not. Outreach is the next step and is
 * said to be, and nothing claims it already works.
 */

type Review = (personId: string, scope: "person" | "account", decision: "kept" | "dropped") => Promise<string | null>;

const REVIEW_WORD: Record<ReviewView, string> = {
  pending: campaignsCopy.reviewPending,
  kept: campaignsCopy.reviewKept,
  dropped: campaignsCopy.reviewDropped,
};

const undecided = (account: AccountView) => account.people.some((person) => person.review === "pending");

function Person({ person, roles, reviewing, busy, press }: { person: FoundPersonView; roles: boolean; reviewing: boolean; busy: boolean; press?: (decision: "kept" | "dropped") => void }) {
  const c = campaignsCopy;
  const dropped = person.review === "dropped";
  const role = roles ? (person.role === null ? c.relatedRole : c.roleParts[person.role]) : null;
  return (
    <li
      data-testid="found-person"
      data-review={person.review}
      data-reveal={person.reveal ?? undefined}
      className={cn("grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-3 gap-y-0.5 py-1.5", dropped && reviewing ? "text-muted" : "")}
    >
      <span className="min-w-0">
        <span className="flex flex-wrap items-baseline gap-x-2">
          <b className={cn("type-name text-14", dropped && reviewing ? "font-medium" : "")}>{person.name}</b>
          <span className="type-small min-w-0 text-muted">{person.title}</span>
          {role === null ? null : (
            <span data-testid="role-chip" className={cn("type-mono text-11", person.role === null ? "text-muted" : "text-action")}>
              {role}
            </span>
          )}
          {person.reused && person.reveal === null ? <span className="type-mono text-11 text-muted">{c.peopleReusedChip}</span> : null}
        </span>
        {person.email === null ? null : (
          // A narrow screen breaks a long address at the @ first, never mid-name; one press selects all of it to copy.
          <span data-testid="person-email" className="type-mono block select-all text-13 text-action">
            {person.email.split("@")[0]}
            <wbr />@{person.email.split("@").slice(1).join("@")}
          </span>
        )}
        {person.reveal !== null ? (
          <span data-testid="reveal-chip" className={cn("type-mono block text-11", person.reveal === "revealed" || person.reveal === "known" ? "text-action" : person.reveal === "suppressed" || person.reveal === "failed" ? "text-warn" : "text-muted")}>
            {c.revealChip[person.reveal]}
          </span>
        ) : null}
        {person.revealWhy === null ? null : (
          <span data-testid="reveal-why" className="type-small block text-muted">
            {person.revealWhy}
          </span>
        )}
        {/* What Relay actually has on them matters while deciding; after the reveal, what came back matters more. */}
        {reviewing ? (
          <span data-testid="why-fits" className="type-small block text-12 text-muted">
            {[...(person.city === null ? [] : [person.city]), ...(person.evidence.length > 0 ? person.evidence : [person.why])].join(c.noteJoin)}
          </span>
        ) : person.city === null ? null : (
          <span className="type-small block text-12 text-muted">{person.city}</span>
        )}
      </span>
      {press === undefined ? (
        reviewing ? (
          <span data-testid="review-chip" className={cn("type-mono text-11", person.review === "kept" ? "text-action" : "text-muted")}>
            {REVIEW_WORD[person.review]}
          </span>
        ) : null
      ) : (
        <span className="flex gap-1.5">
          <ToggleChip data-testid="keep" pressed={person.review === "kept"} disabled={busy} onClick={() => press("kept")}>
            {c.reviewKeep}
          </ToggleChip>
          <ToggleChip data-testid="drop" pressed={person.review === "dropped"} disabled={busy} onClick={() => press("dropped")}>
            {c.reviewDrop}
          </ToggleChip>
        </span>
      )}
    </li>
  );
}

/** One line for an account whose every person is decided: the firm, how many, and the decision. */
function decidedLine(account: AccountView): string {
  const c = campaignsCopy;
  const kept = account.people.filter((person) => person.review === "kept").length;
  const n = account.people.length;
  const word = kept === n ? c.reviewAllKept : kept === 0 ? c.reviewAllDropped : `${kept} ${c.reviewMixed}`;
  return `${n} ${n === 1 ? c.accountPerson : c.accountPeople}${c.noteJoin}${word}`;
}

function Account({ account, roles, reviewing, busy, collapsed, onExpand, press }: { account: AccountView; roles: boolean; reviewing: boolean; busy: boolean; collapsed: boolean; onExpand?: () => void; press?: Review }) {
  const c = campaignsCopy;
  // One person's own Keep or Drop is the whole decision: account presses are only for accounts with more than one (v2.2 note 3).
  const whole = press !== undefined && account.people.length > 1;
  const allKept = account.people.every((person) => person.review === "kept");
  const decided = reviewing && !undecided(account);
  const summary = [
    `${account.people.length} ${account.people.length === 1 ? c.accountPerson : c.accountPeople}`,
    ...(roles && account.parts.length > 0 ? [account.parts.map((part) => c.roleParts[part]).join(", ")] : []),
  ].join(c.noteJoin);
  return (
    <li data-testid="found-account" data-decided={decided ? "true" : undefined} data-collapsed={collapsed ? "true" : undefined} className="min-w-0 border-t border-line py-2.5 first:border-t-0 first:pt-0 [overflow-wrap:anywhere]">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-2">
          <h3 data-testid="account-name" className="type-name text-15">
            {account.company}
          </h3>
          {account.domain === null ? null : <span className="type-mono text-11 text-muted">{account.domain}</span>}
          <span data-testid="account-coverage" className="type-small text-muted">
            {collapsed ? decidedLine(account) : summary}
          </span>
          {account.evidence === null || collapsed ? null : (
            <span data-testid="account-evidence" className="type-small text-12 text-action">
              {account.evidence}
            </span>
          )}
        </div>
        {collapsed && onExpand !== undefined ? (
          <TextButton data-testid="account-change" onClick={onExpand}>
            {c.reviewChange}
          </TextButton>
        ) : !whole || press === undefined || decided ? null : (
          <span className="flex gap-1.5">
            <ToggleChip data-testid="keep-account" pressed={allKept} disabled={busy || allKept} onClick={() => void press(account.personId, "account", "kept")}>
              {c.reviewKeepAccount}
            </ToggleChip>
            <ToggleChip data-testid="drop-account" pressed={false} disabled={busy} onClick={() => void press(account.personId, "account", "dropped")}>
              {c.reviewDropAccount}
            </ToggleChip>
          </span>
        )}
      </div>
      {collapsed ? null : (
        <ul className="mt-1 grid">
          {account.people.map((person) => (
            <Person
              key={person.id}
              person={person}
              roles={roles}
              reviewing={reviewing}
              busy={busy}
              {...(press === undefined ? {} : { press: (decision: "kept" | "dropped") => void press(person.id, "person", decision) })}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

/** The confirmed group's roles, once each, as plain lines: the words a rep will see beside people, and what research says each needs. */
function BuyerRoles({ roles }: { roles: BuyerRoleView[] }) {
  const c = campaignsCopy;
  return (
    <div data-testid="buyer-roles" className="mt-1.5">
      <p className="type-small text-muted">
        <span className="text-ink">{c.buyerRolesLabel}:</span>{" "}
        {roles.map((role) => `${c.roleParts[role.part]} · ${role.title}`).join(c.noteJoin)}
      </p>
      <details data-testid="buyer-role-needs" className="mt-1">
        <summary className="type-small cursor-pointer font-semibold text-action focus-visible:outline-none focus-visible:ring-2">{c.buyerRolesNeeds}</summary>
        <dl className="mt-1.5 grid max-w-measure gap-1.5">
          {roles.map((role) => (
            <div key={`${role.part}:${role.title}`}>
              <dt className="type-small font-semibold">
                {c.roleParts[role.part]} · {role.title}
              </dt>
              <dd className="type-small text-muted">{role.needs}</dd>
            </div>
          ))}
        </dl>
      </details>
    </div>
  );
}

/** Reviewing: what Reveal emails would use for the people kept so far. */
export function revealEstimateLine(view: Pick<PeopleFoundView, "revealPlan">): string | null {
  const c = campaignsCopy;
  const plan = view.revealPlan;
  if (plan === null) return null;
  if (plan.kept === 0) return c.revealNoneKept;
  return `${c.revealKeptAbout} ${plan.maxCredits} ${c.revealCredits}${plan.known > 0 ? ` ${plan.known} ${c.revealReused}` : ""}`;
}

/** After Reveal emails: what came back, what it used, and what comes next. */
function RevealSummary({ view }: { view: PeopleFoundView }) {
  const c = campaignsCopy;
  const result = view.revealResult;
  if (result === null) return null;
  const ready = result.tally.revealed + result.tally.known;
  const without = result.tally.no_email + result.tally.suppressed + result.tally.held;
  return (
    <div className="mt-1.5 grid gap-1">
      {result.running || result.stopped ? null : (
        <p data-testid="ready-counts" className="type-name">
          {ready} {c.readyEmails}
          {without > 0 ? ` · ${without} ${c.readyWithout}` : ""}
          {result.tally.failed > 0 ? ` · ${result.tally.failed} ${c.readyFailed}` : ""}
        </p>
      )}
      <p data-testid="reveal-spend" className="type-small">
        {c.revealUsed} {result.charged} {c.revealUsedOf} {result.maxCredits} {c.spendCredits}
        {result.reserved > 0 ? ` ${result.reserved} ${c.spendHeld}` : ""}
      </p>
      {result.notKept > 0 ? (
        <p data-testid="not-kept" className="type-small text-muted">
          {result.notKept} {result.notKept === 1 ? c.accountPerson : c.accountPeople} {c.notKept}
        </p>
      ) : null}
      {!result.running && ready > 0 ? (
        <p data-testid="outreach-next" className="type-small max-w-measure text-muted">
          <span className="font-semibold text-ink">{c.outreachNextLabel}.</span> {c.outreachNextLine}
        </p>
      ) : null}
    </div>
  );
}

export function PeopleFound({ view, editHref, spent, onReview }: { view: PeopleFoundView; editHref?: string; spent: boolean; onReview?: Review }) {
  const c = campaignsCopy;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reviewing = view.phase === "review";
  // The order the page opened in, kept while the rep works through it: a decision folds an account in place rather than moving it.
  const [order] = useState(() => view.accounts.map((account) => account.personId));
  const accounts = [...view.accounts].sort((a, b) => {
    const ia = order.indexOf(a.personId);
    const ib = order.indexOf(b.personId);
    return (ia === -1 ? order.length : ia) - (ib === -1 ? order.length : ib);
  });
  // Decided accounts fold to one line once the list is long enough to need it (Collapse reviewed folds them sooner); Change opens one.
  const [showReviewed, setShowReviewed] = useState(view.found.n < 20);
  const [opened, setOpened] = useState<Set<string>>(() => new Set());
  const decidedCount = reviewing ? accounts.filter((account) => !undecided(account)).length : 0;
  const multiRole = view.accounts.filter((account) => account.parts.length > 1).length;
  const label = view.phase === "ready" ? c.peopleReadyLabel : view.phase === "revealing" ? c.revealingLabel : c.peopleFoundLabel;
  const estimate = revealEstimateLine(view);

  const press: Review | undefined =
    onReview === undefined || !reviewing
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

  const accountRow = (account: AccountView) => (
    <Account
      key={account.personId}
      account={account}
      roles={view.roles}
      reviewing={reviewing}
      busy={busy}
      collapsed={reviewing && !undecided(account) && !showReviewed && !opened.has(account.personId)}
      onExpand={() => setOpened((current) => new Set(current).add(account.personId))}
      {...(press === undefined ? {} : { press })}
    />
  );

  return (
    <Card label={label}>
      <div data-testid="people-found" data-phase={view.phase}>
        {reviewing ? (
          <>
            <div className="flex flex-wrap items-baseline gap-x-2">
              <p data-testid="found-count" className="type-name">
                {view.found.n} {c.peopleFoundOf} {view.found.ofM}
              </p>
              <p className="type-small text-muted">
                {c.peopleFoundFor} {view.groupName}
              </p>
            </div>
            <p data-testid="accounts-summary" className="type-small">
              {view.found.n} {c.accountsPeopleAt} {view.accounts.length} {c.accountsWord}
              {view.roles && multiRole > 0 ? ` · ${multiRole} ${c.accountsMultiRole}` : ""}
            </p>
            {view.shortfall === null ? null : (
              <p data-testid="shortfall" className="type-small mt-1.5 max-w-measure text-warn">
                {view.shortfall === "cap_reached" ? c.shortfallCapReached : view.shortfall === "fewer_strong_matches" ? c.shortfallFewerStrong : c.shortfallNoMore}
              </p>
            )}
            {view.spare > 0 ? (
              <p data-testid="spare-count" className="type-small mt-1 text-muted">
                {view.spare} {c.summaryWeakerHeld}.
              </p>
            ) : null}
            {view.rolesMissing.length > 0 ? (
              <p data-testid="roles-missing" className="type-small mt-1 text-muted">
                {c.rolesMissingLead} {view.rolesMissing.map((role) => `${c.roleParts[role.part]} (${role.title})`).join(", ")}.
              </p>
            ) : null}
            <p data-testid="search-line" className="type-small mt-1.5 max-w-measure text-muted">
              {view.search}
            </p>
            {view.buyerRoles.length === 0 ? null : <BuyerRoles roles={view.buyerRoles} />}
            <div data-testid="review-bar" className="mt-3 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-y border-line py-2">
              <div>
                <p data-testid="review-counts" className="type-small">
                  <span className="font-semibold">{view.review.kept} {c.reviewCountKept}</span> · {view.review.dropped} {c.reviewCountDropped} · {view.review.pending} {c.reviewCountPending}
                </p>
                {estimate === null ? null : (
                  <p data-testid="reveal-estimate" className="type-small text-12 text-muted">
                    {estimate}
                  </p>
                )}
              </div>
              {decidedCount > 0 ? (
                <TextButton data-testid="show-reviewed" aria-pressed={showReviewed} onClick={() => setShowReviewed(!showReviewed)}>
                  {showReviewed ? `${c.reviewCollapseReviewed} (${decidedCount})` : `${c.reviewShowReviewed} (${decidedCount})`}
                </TextButton>
              ) : null}
            </div>
          </>
        ) : (
          <>
            <p className="type-small text-muted">
              {c.peopleFoundFor} {view.groupName}
            </p>
            <RevealSummary view={view} />
          </>
        )}
        {error === null ? null : (
          <p role="alert" data-testid="review-error" className="type-small mt-1.5 text-warn">
            {error}
          </p>
        )}

        {view.phase === "ready" ? (
          // Ready: the accounts with an email to write to first; the rest folded, a press away.
          <>
            <ol data-testid="ready-accounts" className="mt-3 grid">
              {accounts.filter((account) => account.people.some((person) => person.email !== null)).map(accountRow)}
            </ol>
            {accounts.some((account) => account.people.every((person) => person.email === null)) ? (
              <details data-testid="not-ready" className="mt-3">
                <summary className="type-small cursor-pointer font-semibold text-action focus-visible:outline-none focus-visible:ring-2">
                  {c.readyWithoutSummary} ({accounts.filter((account) => account.people.every((person) => person.email === null)).length})
                </summary>
                <ol className="mt-2 grid">{accounts.filter((account) => account.people.every((person) => person.email === null)).map(accountRow)}</ol>
              </details>
            ) : null}
          </>
        ) : (
          <ol className={cn("grid", reviewing ? "mt-1" : "mt-3")}>{accounts.map(accountRow)}</ol>
        )}

        <div className="mt-3 grid gap-1 border-t border-line pt-3">
          {view.onHold > 0 ? (
            <p data-testid="on-hold" className="type-small text-muted">
              {view.onHold} {c.peopleHeldBack}
            </p>
          ) : null}
          <p data-testid="spend-line" className="type-small text-muted">
            {c.spendUsed} {view.spend.charged} {c.spendOf} {view.spend.cap} {c.spendCredits}
            {view.spend.reserved > 0 ? ` ${view.spend.reserved} ${c.spendHeld}` : ""}
            {view.sample ? ` ${c.spendSample}` : ""}
          </p>
          {reviewing && editHref !== undefined && spent ? (
            <p data-testid="edit-warning" className="type-small max-w-measure text-muted">
              {c.editWarning}
            </p>
          ) : null}
        </div>
      </div>
    </Card>
  );
}
