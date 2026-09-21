"use client";

import { useState } from "react";

import { Card } from "@/components/Card";
import { TextButton } from "@/components/TextButton";
import { ToggleChip } from "@/components/ToggleChip";
import type { AccountView, BuyerRoleView, FoundPersonView, PeopleFoundView, ReviewView } from "@/lib/campaigns/types";
import { campaignsCopy } from "@/lib/copy/campaigns";
import { cn } from "@/lib/utils";

import { ReviewWorkspace, type ReviewPress } from "./ReviewWorkspace";

/**
 * Reviewing people (lead gen v2.2 §9a), then People ready (v2.1 §11):
 * accounts first, the people Relay chose nested under each.
 *
 * Reviewing (final MVP pass) is the `ReviewWorkspace`: one row per account,
 * the accounts still to decide by default, twenty to a page, opened in
 * place to their people. This card carries what is said once above it: the
 * count, the plan's search, the buyer roles, and, after the list, the spend.
 *
 * After Reveal emails: only the kept people, each with their email when it is
 * ready and usable, or one line on why not. Outreach is the next step and is
 * said to be, and nothing claims it already works.
 */

const REVIEW_WORD: Record<ReviewView, string> = {
  pending: campaignsCopy.reviewPending,
  kept: campaignsCopy.reviewKept,
  dropped: campaignsCopy.reviewDropped,
};

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
          {person.draft !== undefined && person.draft !== null ? (
            <span data-testid="draft-chip" className={cn("type-mono text-11", person.draft === "needs_you" || person.draft === "failed" ? "text-warn" : person.draft === "approved" ? "text-action" : "text-muted")}>
              {c.draftChip[person.draft]}
            </span>
          ) : null}
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

/** An account after Reveal: the firm, then its kept people with their emails or why not. */
function Account({ account, roles, busy }: { account: AccountView; roles: boolean; busy: boolean }) {
  const c = campaignsCopy;
  const summary = [
    `${account.people.length} ${account.people.length === 1 ? c.accountPerson : c.accountPeople}`,
    ...(roles && account.parts.length > 0 ? [account.parts.map((part) => c.roleParts[part]).join(", ")] : []),
  ].join(c.noteJoin);
  return (
    <li data-testid="found-account" className="min-w-0 border-t border-line py-2.5 first:border-t-0 first:pt-0 [overflow-wrap:anywhere]">
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-2">
        <h3 data-testid="account-name" className="type-name text-15">
          {account.company}
        </h3>
        {account.domain === null ? null : <span className="type-mono text-11 text-muted">{account.domain}</span>}
        <span data-testid="account-coverage" className="type-small text-muted">
          {summary}
        </span>
        {account.evidence === null ? null : (
          <span data-testid="account-evidence" className="type-small text-12 text-action">
            {account.evidence}
          </span>
        )}
      </div>
      <ul className="mt-1 grid">
        {account.people.map((person) => (
          <Person key={person.id} person={person} roles={roles} reviewing={false} busy={busy} />
        ))}
      </ul>
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
      {view.drafts !== undefined && view.drafts !== null ? null : !result.running && ready > 0 ? (
        <p data-testid="outreach-next" className="type-small max-w-measure text-muted">
          <span className="font-semibold text-ink">{c.outreachNextLabel}.</span> {c.outreachNextLine}
        </p>
      ) : null}
    </div>
  );
}

export function PeopleFound({ view, editHref, spent, onReview }: { view: PeopleFoundView; editHref?: string; spent: boolean; onReview?: ReviewPress }) {
  const c = campaignsCopy;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reviewing = view.phase === "review";
  const multiRole = view.accounts.filter((account) => account.parts.length > 1).length;
  const label = view.phase === "ready" ? c.peopleReadyLabel : view.phase === "revealing" ? c.revealingLabel : c.peopleFoundLabel;
  const estimate = revealEstimateLine(view);

  const press: ReviewPress | undefined =
    onReview === undefined || !reviewing
      ? undefined
      : async (personId, scope, decision, personIds) => {
          if (busy) return null;
          setBusy(true);
          setError(null);
          try {
            const line = await onReview(personId, scope, decision, personIds);
            if (line !== null) setError(line);
            return line;
          } catch {
            setError(c.cannotChange);
            return c.cannotChange;
          } finally {
            setBusy(false);
          }
        };

  const accountRow = (account: AccountView) => <Account key={account.personId} account={account} roles={view.roles} busy={busy} />;

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
            {error === null ? null : (
              <p role="alert" data-testid="review-error" className="type-small mt-1.5 text-warn">
                {error}
              </p>
            )}
            <div className="mt-3">
              <ReviewWorkspace view={view} estimate={estimate} busy={busy} {...(press === undefined ? {} : { press })} />
            </div>
          </>
        ) : (
          <>
            <p className="type-small text-muted">
              {c.peopleFoundFor} {view.groupName}
            </p>
            <RevealSummary view={view} />
            {view.phase === "ready" ? (
              // Ready: the accounts with an email to write to first; the rest folded, a press away.
              <>
                <ol data-testid="ready-accounts" className="mt-3 grid">
                  {view.accounts.filter((account) => account.people.some((person) => person.email !== null)).map(accountRow)}
                </ol>
                {view.accounts.some((account) => account.people.every((person) => person.email === null)) ? (
                  <details data-testid="not-ready" className="mt-3">
                    <summary className="type-small cursor-pointer font-semibold text-action focus-visible:outline-none focus-visible:ring-2">
                      {c.readyWithoutSummary} ({view.accounts.filter((account) => account.people.every((person) => person.email === null)).length})
                    </summary>
                    <ol className="mt-2 grid">{view.accounts.filter((account) => account.people.every((person) => person.email === null)).map(accountRow)}</ol>
                  </details>
                ) : null}
              </>
            ) : (
              <ol className="mt-3 grid">{view.accounts.map(accountRow)}</ol>
            )}
          </>
        )}

        <div className="mt-3 grid gap-1 border-t border-line pt-3">
          {/* Someone already in another campaign has their own line, so they are not counted under the rules too. */}
          {view.onHold - (view.inOtherCampaign ?? 0) > 0 ? (
            <p data-testid="on-hold" className="type-small text-muted">
              {view.onHold - (view.inOtherCampaign ?? 0)} {c.peopleHeldBack}
            </p>
          ) : null}
          {(view.inOtherCampaign ?? 0) > 0 ? (
            <p data-testid="in-other-campaign" className="type-small text-muted">
              {view.inOtherCampaign} {c.peopleInOtherCampaign}
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
