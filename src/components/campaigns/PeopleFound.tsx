"use client";

import { useState } from "react";

import { Card } from "@/components/Card";
import { Chip } from "@/components/Chip";
import type { AccountView, BuyerRoleView, FoundPersonView, PeopleFoundView, RevealStateView, ReviewView } from "@/lib/campaigns/types";
import { campaignsCopy } from "@/lib/copy/campaigns";
import { cn } from "@/lib/utils";

/**
 * Reviewing people (lead gen v2.2 §9a), then People ready (v2.1 §11):
 * accounts first, the people Relay chose nested under each.
 *
 * Reviewing: the rep's keep or drop on every one, and what revealing the kept
 * people's emails would use, near the top. The plan's search is said once
 * above the accounts, and each buyer role's needs once, a press away (v2.2
 * note 3). Each person says the role they matched in one short line. No email
 * and no provider id.
 *
 * After Reveal emails: only the kept people, each with their email when it is
 * ready and usable, or one line on why not. Outreach is the next step and is
 * said to be, and nothing claims it already works.
 */

type Review = (personId: string, scope: "person" | "account", decision: "kept" | "dropped") => Promise<string | null>;

const REVIEW_CHIP: Record<ReviewView, { tone: "default" | "ok" | "warn"; word: string }> = {
  pending: { tone: "default", word: campaignsCopy.reviewPending },
  kept: { tone: "ok", word: campaignsCopy.reviewKept },
  dropped: { tone: "warn", word: campaignsCopy.reviewDropped },
};

const REVEAL_TONE: Record<RevealStateView, "default" | "ok" | "warn"> = {
  revealed: "ok",
  known: "ok",
  no_email: "default",
  suppressed: "warn",
  held: "default",
  failed: "warn",
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

function Person({ person, roles, reviewing, busy, press }: { person: FoundPersonView; roles: boolean; reviewing: boolean; busy: boolean; press?: (decision: "kept" | "dropped") => void }) {
  const c = campaignsCopy;
  const chip = REVIEW_CHIP[person.review];
  return (
    <li data-testid="found-person" data-review={person.review} data-reveal={person.reveal ?? undefined} className="flex flex-col gap-2 sm:flex-row sm:items-start sm:gap-3">
      <span className="min-w-0 sm:flex-1">
        <b className="type-name block text-14">
          {person.name} · {person.title}
        </b>
        {person.email === null ? null : (
          <span data-testid="person-email" className="type-mono block text-13 text-action">
            {person.email}
          </span>
        )}
        {person.city === null ? null : <span className="type-small block text-muted">{person.city}</span>}
        <span className="mt-1 flex flex-wrap items-center gap-1.5">
          {roles ? (
            <Chip tone={person.role === null ? "default" : "ok"}>
              <span data-testid="role-chip">{person.role === null ? c.relatedRole : c.roleParts[person.role]}</span>
            </Chip>
          ) : null}
          {person.reveal !== null ? (
            <Chip tone={REVEAL_TONE[person.reveal]}>
              <span data-testid="reveal-chip">{c.revealChip[person.reveal]}</span>
            </Chip>
          ) : (
            <>
              {person.reused ? <Chip tone="ok">{c.peopleReusedChip}</Chip> : null}
              <Chip tone={chip.tone}>
                <span data-testid="review-chip">{chip.word}</span>
              </Chip>
            </>
          )}
        </span>
        {person.revealWhy === null ? null : (
          <span data-testid="reveal-why" className="type-small mt-1 block text-muted">
            {person.revealWhy}
          </span>
        )}
        {/* Why they fit matters while deciding; after the reveal, what came back matters more. */}
        {reviewing ? (
          <span data-testid="why-fits" className="type-small mt-1 block text-muted">
            {person.why}
          </span>
        ) : null}
      </span>
      {press === undefined ? null : (
        <span className="flex gap-1.5 sm:shrink-0">
          <ReviewButton testId="keep" label={c.reviewKeep} pressed={person.review === "kept"} disabled={busy} onPress={() => press("kept")} />
          <ReviewButton testId="drop" label={c.reviewDrop} pressed={person.review === "dropped"} disabled={busy} onPress={() => press("dropped")} />
        </span>
      )}
    </li>
  );
}

function Account({ account, roles, reviewing, busy, press }: { account: AccountView; roles: boolean; reviewing: boolean; busy: boolean; press?: Review }) {
  const c = campaignsCopy;
  // One person's own Keep or Drop is the whole decision: account presses are only for accounts with more than one (v2.2 note 3).
  const whole = press !== undefined && account.people.length > 1;
  const allKept = account.people.every((person) => person.review === "kept");
  return (
    <li data-testid="found-account" className="min-w-0 rounded-input border border-line p-3 [overflow-wrap:anywhere]">
      <div className="flex flex-col items-start gap-2 sm:flex-row sm:justify-between">
        <div className="min-w-0 sm:flex-1">
          <h3 data-testid="account-name" className="type-name text-15">
            {account.company}
          </h3>
          {account.domain === null ? null : <p className="type-small text-muted">{account.domain}</p>}
          <p data-testid="account-coverage" className="type-small mt-0.5">
            {account.people.length} {account.people.length === 1 ? c.accountPerson : c.accountPeople}
            {roles && account.parts.length > 0 ? ` · ${account.parts.map((part) => c.roleParts[part]).join(", ")}` : ""}
          </p>
          {account.evidence === null ? null : (
            <p data-testid="account-evidence" className="type-small text-muted">
              {account.evidence}
            </p>
          )}
        </div>
        {!whole || press === undefined ? null : (
          <span className="flex gap-1.5">
            <ReviewButton testId="keep-account" label={c.reviewKeepAccount} pressed={allKept} disabled={busy || allKept} onPress={() => void press(account.personId, "account", "kept")} />
            <ReviewButton testId="drop-account" label={c.reviewDropAccount} pressed={false} disabled={busy} onPress={() => void press(account.personId, "account", "dropped")} />
          </span>
        )}
      </div>
      <ul className="mt-2.5 grid gap-2.5 border-t border-line pt-2.5">
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
    </li>
  );
}

/** The confirmed group's roles, once each: the chips a rep will see, and, a press away, what research says each needs. */
function BuyerRoles({ roles }: { roles: BuyerRoleView[] }) {
  const c = campaignsCopy;
  return (
    <div data-testid="buyer-roles" className="mt-3 rounded-input border border-line p-3">
      <p className="type-label mb-1.5">{c.buyerRolesLabel}</p>
      <ul className="grid gap-1">
        {roles.map((role) => (
          <li key={`${role.part}:${role.title}`} className="flex flex-wrap items-center gap-1.5">
            <Chip tone="ok">{c.roleParts[role.part]}</Chip>
            <span className="type-small">{role.title}</span>
          </li>
        ))}
      </ul>
      <details data-testid="buyer-role-needs" className="mt-2">
        <summary className="type-small cursor-pointer font-semibold text-action focus-visible:outline-none focus-visible:ring-2">{c.buyerRolesNeeds}</summary>
        <dl className="mt-1.5 grid gap-1.5">
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
function RevealEstimate({ view }: { view: PeopleFoundView }) {
  const c = campaignsCopy;
  const plan = view.revealPlan;
  if (plan === null) return null;
  return (
    <p data-testid="reveal-estimate" className="type-small mt-1 text-muted">
      {plan.kept === 0 ? (
        c.revealNoneKept
      ) : (
        <>
          {c.revealKeptAbout} {plan.maxCredits} {c.revealCredits}
          {plan.known > 0 ? ` ${plan.known} ${c.revealReused}` : ""}
        </>
      )}
    </p>
  );
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
      {result.running ? null : (
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
        <div data-testid="outreach-next" className="mt-1.5 rounded-input bg-soft px-3 py-2.5">
          <p className="type-label">{c.outreachNextLabel}</p>
          <p className="type-small">{c.outreachNextLine}</p>
        </div>
      ) : null}
    </div>
  );
}

export function PeopleFound({ view, editHref, spent, onReview }: { view: PeopleFoundView; editHref?: string; spent: boolean; onReview?: Review }) {
  const c = campaignsCopy;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const multiRole = view.accounts.filter((account) => account.parts.length > 1).length;
  const reviewing = view.phase === "review";
  const label = view.phase === "ready" ? c.peopleReadyLabel : view.phase === "revealing" ? c.revealingLabel : c.peopleFoundLabel;

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

  return (
    <Card label={label}>
      <div data-testid="people-found" data-phase={view.phase}>
        {reviewing ? (
          <>
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
            <RevealEstimate view={view} />
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
        {reviewing ? (
          <>
            <p data-testid="search-line" className="type-small mt-1.5 text-muted">
              {view.search}
            </p>
            {view.buyerRoles.length === 0 ? null : <BuyerRoles roles={view.buyerRoles} />}
          </>
        ) : null}

        {view.phase === "ready" ? (
          // Ready: the accounts with an email to write to first; the rest folded, a press away.
          <>
            <ol data-testid="ready-accounts" className="mt-3 grid gap-3">
              {view.accounts
                .filter((account) => account.people.some((person) => person.email !== null))
                .map((account) => (
                  <Account key={account.personId} account={account} roles={view.roles} reviewing={false} busy={busy} />
                ))}
            </ol>
            {view.accounts.some((account) => account.people.every((person) => person.email === null)) ? (
              <details data-testid="not-ready" className="mt-3">
                <summary className="type-small cursor-pointer font-semibold text-action focus-visible:outline-none focus-visible:ring-2">
                  {c.readyWithoutSummary} ({view.accounts.filter((account) => account.people.every((person) => person.email === null)).length})
                </summary>
                <ol className="mt-2 grid gap-3">
                  {view.accounts
                    .filter((account) => account.people.every((person) => person.email === null))
                    .map((account) => (
                      <Account key={account.personId} account={account} roles={view.roles} reviewing={false} busy={busy} />
                    ))}
                </ol>
              </details>
            ) : null}
          </>
        ) : (
          <ol className="mt-3 grid gap-3">
            {view.accounts.map((account) => (
              <Account key={account.personId} account={account} roles={view.roles} reviewing={reviewing} busy={busy} {...(press === undefined ? {} : { press })} />
            ))}
          </ol>
        )}

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
          {reviewing && editHref !== undefined && spent ? (
            <p data-testid="edit-warning" className="type-small text-muted">
              {c.editWarning}
            </p>
          ) : null}
        </div>
      </div>
    </Card>
  );
}
