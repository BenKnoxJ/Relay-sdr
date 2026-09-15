"use client";

import { useId, useMemo, useState } from "react";

import { TextButton } from "@/components/TextButton";
import { ToggleChip } from "@/components/ToggleChip";
import type { AccountView, FoundPersonView, PeopleFoundView, RolePartView } from "@/lib/campaigns/types";
import { campaignsCopy } from "@/lib/copy/campaigns";
import { cn } from "@/lib/utils";

/**
 * Reviewing people as a workspace (lead gen v2.2 §9a; final MVP pass):
 * one compact row per account, the accounts still to decide by default,
 * twenty accounts to a page and never an account split across two.
 *
 * The toolbar sticks under the page header: the counts, the view (To review,
 * Kept, Dropped, All), a search over accounts and people, a role and an
 * email filter, and, once something is ticked, Keep selected and Drop
 * selected. An account opens in place to its one to three people, each with
 * what Relay holds on them and its own Keep or Drop. Keep account and Drop
 * account stay on the row. Reveal emails stays the header's separate spend
 * gate; nothing here buys anything.
 *
 * The accounts arrive whole from the campaign read model (a campaign holds
 * at most a few hundred people); views, filters, search and pages are
 * worked out here, so a press changes one thing on the screen and the server
 * is asked once per decision.
 */

export type ReviewPress = (personId: string, scope: "person" | "account" | "selected", decision: "kept" | "dropped", personIds?: string[]) => Promise<string | null>;

type View = "toReview" | "kept" | "dropped" | "all";
type EmailFilter = "any" | "with" | "without";

export const PAGE_SIZE = 20;

const PARTS: readonly RolePartView[] = ["runs", "champions", "signs"];

const pendingAt = (account: AccountView) => account.people.filter((person) => person.review === "pending").length;
const keptAt = (account: AccountView) => account.people.filter((person) => person.review === "kept").length;
const emailsAt = (account: AccountView) => account.people.filter((person) => person.hasEmail).length;

/** The account's review in one phrase: "to review", "kept", "1 of 2 kept", "dropped". */
export function accountStateOf(account: AccountView): { word: string; tone: "pending" | "kept" | "dropped" | "mixed" } {
  const c = campaignsCopy;
  const n = account.people.length;
  const pending = pendingAt(account);
  const kept = keptAt(account);
  if (pending === n) return { word: c.reviewStateToReview, tone: "pending" };
  if (pending > 0) return { word: `${n - pending} ${c.reviewStateOf} ${n} decided`, tone: "mixed" };
  if (kept === n) return { word: c.reviewStateKept, tone: "kept" };
  if (kept === 0) return { word: c.reviewStateDropped, tone: "dropped" };
  return { word: `${kept} ${c.reviewStateOf} ${n} ${c.reviewStateKept}`, tone: "mixed" };
}

function inView(account: AccountView, view: View): boolean {
  switch (view) {
    case "toReview":
      return pendingAt(account) > 0;
    case "kept":
      return keptAt(account) > 0;
    case "dropped":
      return account.people.some((person) => person.review === "dropped");
    case "all":
      return true;
  }
}

function matches(account: AccountView, needle: string): boolean {
  if (needle === "") return true;
  const hay = [account.company, account.domain ?? "", ...account.people.flatMap((person) => [person.name, person.title])].join(" ").toLowerCase();
  return needle
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((word) => hay.includes(word));
}

function Person({ person, roles, selected, busy, onSelect, press }: { person: FoundPersonView; roles: boolean; selected: boolean; busy: boolean; onSelect: (on: boolean) => void; press?: (decision: "kept" | "dropped") => void }) {
  const c = campaignsCopy;
  const role = roles ? (person.role === null ? c.relatedRole : c.roleParts[person.role]) : null;
  const dropped = person.review === "dropped";
  return (
    <li data-testid="found-person" data-review={person.review} className={cn("grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-x-2.5 py-1.5 pl-1", dropped ? "text-muted" : "")}>
      <input type="checkbox" aria-label={`${c.reviewSelectPerson}: ${person.name}`} data-testid="select-person" checked={selected} disabled={busy} onChange={(event) => onSelect(event.target.checked)} className="mt-1 h-3.5 w-3.5 accent-action" />
      <span className="min-w-0">
        <span className="flex flex-wrap items-baseline gap-x-2">
          <b className="type-name text-14">{person.name}</b>
          <span className="type-small min-w-0 text-muted">{person.title}</span>
          {role === null ? null : (
            <span data-testid="role-chip" className={cn("type-mono text-11", person.role === null ? "text-muted" : "text-action")}>
              {role}
            </span>
          )}
          {person.reused ? <span className="type-mono text-11 text-muted">{c.peopleReusedChip}</span> : null}
        </span>
        <span data-testid="why-fits" className="type-small block text-12 text-muted">
          {[...(person.city === null ? [] : [person.city]), ...(person.evidence.length > 0 ? person.evidence : [person.why])].join(c.noteJoin)}
        </span>
      </span>
      {press === undefined ? (
        <span data-testid="review-chip" className={cn("type-mono text-11", person.review === "kept" ? "text-action" : "text-muted")}>
          {person.review === "kept" ? c.reviewKept : person.review === "dropped" ? c.reviewDropped : c.reviewPending}
        </span>
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

function AccountRow({
  account,
  roles,
  open,
  onToggle,
  selection,
  onSelect,
  busy,
  press,
}: {
  account: AccountView;
  roles: boolean;
  open: boolean;
  onToggle: () => void;
  selection: Set<string>;
  onSelect: (ids: string[], on: boolean) => void;
  busy: boolean;
  press?: ReviewPress;
}) {
  const c = campaignsCopy;
  const ids = account.people.map((person) => person.id);
  const selectedCount = ids.filter((id) => selection.has(id)).length;
  const allSelected = selectedCount === ids.length;
  const state = accountStateOf(account);
  const n = account.people.length;
  const emails = emailsAt(account);
  const whole = press !== undefined && n > 1;
  const allKept = keptAt(account) === n;
  const allDropped = account.people.every((person) => person.review === "dropped");
  const panel = useId();
  return (
    <li data-testid="found-account" data-state={state.tone} data-open={open ? "true" : undefined} className="border-t border-line first:border-t-0">
      <div className="grid grid-cols-[auto_minmax(0,1fr)] items-start gap-x-2.5 gap-y-1 py-2 sm:grid-cols-[auto_minmax(0,1fr)_auto]">
        <input
          type="checkbox"
          aria-label={`${c.reviewSelectAccount}: ${account.company}`}
          data-testid="select-account"
          checked={allSelected}
          ref={(element) => {
            if (element !== null) element.indeterminate = selectedCount > 0 && !allSelected;
          }}
          disabled={busy}
          onChange={(event) => onSelect(ids, event.target.checked)}
          className="mt-1.5 h-3.5 w-3.5 accent-action"
        />
        <button type="button" data-testid="account-toggle" aria-expanded={open} aria-controls={panel} onClick={onToggle} className="min-w-0 text-left focus-visible:outline-none focus-visible:ring-2">
          <span className="flex flex-wrap items-baseline gap-x-2">
            <span data-testid="account-name" className="type-name text-15">
              {account.company}
            </span>
            {account.domain === null ? null : <span className="type-mono text-11 text-muted">{account.domain}</span>}
          </span>
          <span data-testid="account-coverage" className="type-small block text-muted">
            {[
              `${n} ${n === 1 ? c.accountPerson : c.accountPeople}`,
              ...(emails > 0 ? [`${emails} ${c.reviewWithEmail}`] : []),
              ...(roles && account.parts.length > 0 ? [account.parts.map((part) => c.roleParts[part]).join(", ")] : []),
              ...(account.evidence === null ? [] : [account.evidence]),
            ].join(c.noteJoin)}
          </span>
        </button>
        <span className="col-start-2 flex flex-wrap items-center gap-x-2 gap-y-1 sm:col-start-3 sm:justify-end">
          <span data-testid="account-state" className={cn("type-mono text-11", state.tone === "kept" ? "text-action" : state.tone === "pending" ? "text-warn" : "text-muted")}>
            {state.word}
          </span>
          {whole && press !== undefined ? (
            <>
              <ToggleChip data-testid="keep-account" pressed={allKept} disabled={busy || allKept} onClick={() => void press(account.personId, "account", "kept")}>
                {c.reviewKeepAccount}
              </ToggleChip>
              <ToggleChip data-testid="drop-account" pressed={allDropped} disabled={busy || allDropped} onClick={() => void press(account.personId, "account", "dropped")}>
                {c.reviewDropAccount}
              </ToggleChip>
            </>
          ) : null}
          <TextButton data-testid="account-open" aria-expanded={open} aria-controls={panel} onClick={onToggle} className="min-h-7">
            {open ? c.reviewCloseAccount : c.reviewOpenAccount}
          </TextButton>
        </span>
      </div>
      {open ? (
        <ul id={panel} className="grid pb-2 pl-6">
          {account.people.map((person) => (
            <Person
              key={person.id}
              person={person}
              roles={roles}
              selected={selection.has(person.id)}
              busy={busy}
              onSelect={(on) => onSelect([person.id], on)}
              {...(press === undefined ? {} : { press: (decision: "kept" | "dropped") => void press(person.id, "person", decision) })}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

export function ReviewWorkspace({ view, estimate, busy, press }: { view: PeopleFoundView; estimate: string | null; busy: boolean; press?: ReviewPress }) {
  const c = campaignsCopy;
  const [current, setCurrent] = useState<View>("toReview");
  const [search, setSearch] = useState("");
  const [role, setRole] = useState<RolePartView | null>(null);
  const [email, setEmail] = useState<EmailFilter>("any");
  const [page, setPage] = useState(0);
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const [selection, setSelection] = useState<Set<string>>(() => new Set());
  const searchId = useId();

  const counts = useMemo(
    () => ({
      toReview: view.accounts.filter((account) => inView(account, "toReview")).length,
      kept: view.accounts.filter((account) => inView(account, "kept")).length,
      dropped: view.accounts.filter((account) => inView(account, "dropped")).length,
      all: view.accounts.length,
    }),
    [view.accounts],
  );
  const shown = useMemo(
    () =>
      view.accounts.filter(
        (account) =>
          inView(account, current) &&
          matches(account, search) &&
          (role === null || account.parts.includes(role)) &&
          (email === "any" || (email === "with" ? emailsAt(account) > 0 : emailsAt(account) < account.people.length)),
      ),
    [view.accounts, current, search, role, email],
  );
  const pages = Math.max(1, Math.ceil(shown.length / PAGE_SIZE));
  const at = Math.min(page, pages - 1);
  const onPage = shown.slice(at * PAGE_SIZE, (at + 1) * PAGE_SIZE);
  const pageIds = onPage.flatMap((account) => account.people.map((person) => person.id));
  const selectedOnPage = pageIds.filter((id) => selection.has(id));
  const allOpen = onPage.length > 0 && onPage.every((account) => open.has(account.personId));
  const filtered = search !== "" || role !== null || email !== "any";

  const setView = (next: View) => {
    setCurrent(next);
    setPage(0);
  };
  const select = (ids: string[], on: boolean) =>
    setSelection((now) => {
      const next = new Set(now);
      for (const id of ids) if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  const toggle = (id: string) =>
    setOpen((now) => {
      const next = new Set(now);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const decideSelected = async (decision: "kept" | "dropped") => {
    if (press === undefined || selection.size === 0) return;
    const ids = [...selection];
    const failed = await press(ids[0]!, "selected", decision, ids);
    if (failed === null) setSelection(new Set());
  };

  const views: { id: View; label: string; n: number }[] = [
    { id: "toReview", label: c.reviewViewToReview, n: counts.toReview },
    { id: "kept", label: c.reviewViewKept, n: counts.kept },
    { id: "dropped", label: c.reviewViewDropped, n: counts.dropped },
    { id: "all", label: c.reviewViewAll, n: counts.all },
  ];

  return (
    <div data-testid="review-workspace">
      <div data-testid="review-bar" className="-mx-card sticky top-[var(--relay-header-h,0px)] z-[5] grid gap-2 border-y border-line bg-panel px-card py-2">
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
          <p data-testid="review-counts" className="type-small">
            <span className="font-semibold">{view.review.kept} {c.reviewCountKept}</span> · {view.review.dropped} {c.reviewCountDropped} · {view.review.pending} {c.reviewCountPending}
            <span className="text-muted">
              {c.noteJoin}
              {view.accounts.length} {c.reviewCountAccounts}
              {c.noteJoin}
              {view.accounts.reduce((total, account) => total + account.people.length, 0)} {c.reviewCountPeople}
            </span>
          </p>
          {estimate === null ? null : (
            <p data-testid="reveal-estimate" className="type-small text-12 text-muted">
              {estimate}
            </p>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <div role="tablist" aria-label={c.reviewViewsLabel} className="flex flex-wrap gap-1">
            {views.map((entry) => (
              <ToggleChip key={entry.id} role="tab" aria-selected={current === entry.id} data-testid={`review-view-${entry.id}`} pressed={current === entry.id} onClick={() => setView(entry.id)}>
                {entry.label} <span className="type-mono ml-1 text-11 font-normal opacity-80">{entry.n}</span>
              </ToggleChip>
            ))}
          </div>
          <label htmlFor={searchId} className="sr-only">
            {c.reviewSearchLabel}
          </label>
          <input
            id={searchId}
            type="search"
            data-testid="review-search"
            value={search}
            placeholder={c.reviewSearchPlaceholder}
            onChange={(event) => {
              setSearch(event.target.value);
              setPage(0);
            }}
            className="type-small min-h-7 min-w-[180px] flex-1 rounded-pill border border-line bg-ground px-3 focus-visible:outline-none focus-visible:ring-2 sm:max-w-[280px]"
          />
          {view.roles ? (
            <div className="flex flex-wrap gap-1" aria-label={c.reviewFilterRole}>
              {PARTS.map((part) => (
                <ToggleChip
                  key={part}
                  data-testid={`review-role-${part}`}
                  pressed={role === part}
                  onClick={() => {
                    setRole(role === part ? null : part);
                    setPage(0);
                  }}
                >
                  {c.roleParts[part]}
                </ToggleChip>
              ))}
            </div>
          ) : null}
          <ToggleChip
            data-testid="review-email"
            pressed={email !== "any"}
            onClick={() => {
              setEmail(email === "any" ? "with" : email === "with" ? "without" : "any");
              setPage(0);
            }}
          >
            {email === "without" ? c.reviewFilterNoEmail : c.reviewFilterEmail}
          </ToggleChip>
          {filtered ? (
            <TextButton
              data-testid="review-clear"
              onClick={() => {
                setSearch("");
                setRole(null);
                setEmail("any");
                setPage(0);
              }}
            >
              {c.reviewFiltersClear}
            </TextButton>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <label className="type-small flex items-center gap-2 text-muted">
            <input
              type="checkbox"
              data-testid="select-page"
              aria-label={c.reviewSelectAllPage}
              checked={pageIds.length > 0 && selectedOnPage.length === pageIds.length}
              ref={(element) => {
                if (element !== null) element.indeterminate = selectedOnPage.length > 0 && selectedOnPage.length < pageIds.length;
              }}
              disabled={busy || pageIds.length === 0}
              onChange={(event) => select(pageIds, event.target.checked)}
              className="h-3.5 w-3.5 accent-action"
            />
            <span data-testid="selection-count">
              {selection.size} {c.reviewSelected}
            </span>
          </label>
          {selection.size > 0 && press !== undefined ? (
            <>
              <ToggleChip data-testid="keep-selected" pressed={false} disabled={busy} onClick={() => void decideSelected("kept")} className="text-action">
                {c.reviewKeepSelected}
              </ToggleChip>
              <ToggleChip data-testid="drop-selected" pressed={false} disabled={busy} onClick={() => void decideSelected("dropped")}>
                {c.reviewDropSelected}
              </ToggleChip>
              <TextButton data-testid="clear-selection" onClick={() => setSelection(new Set())}>
                {c.reviewClearSelection}
              </TextButton>
            </>
          ) : null}
          <span className="ml-auto flex flex-wrap items-center gap-x-3">
            <TextButton data-testid="expand-all" onClick={() => setOpen(allOpen ? new Set() : new Set(onPage.map((account) => account.personId)))}>
              {allOpen ? c.reviewCollapseAll : c.reviewExpandAll}
            </TextButton>
            <Pager page={at} pages={pages} shown={shown.length} onPage={setPage} />
          </span>
        </div>
      </div>

      {onPage.length === 0 ? (
        <p data-testid="review-empty" className="type-small mt-3 text-muted">
          {c.reviewNoMatch}
        </p>
      ) : (
        <ol data-testid="review-accounts" className="grid">
          {onPage.map((account) => (
            <AccountRow
              key={account.personId}
              account={account}
              roles={view.roles}
              open={open.has(account.personId)}
              onToggle={() => toggle(account.personId)}
              selection={selection}
              onSelect={select}
              busy={busy}
              {...(press === undefined ? {} : { press })}
            />
          ))}
        </ol>
      )}
      {pages > 1 ? (
        <div className="mt-2 flex justify-end border-t border-line pt-2">
          <Pager page={at} pages={pages} shown={shown.length} onPage={setPage} />
        </div>
      ) : null}
    </div>
  );
}

function Pager({ page, pages, shown, onPage }: { page: number; pages: number; shown: number; onPage: (page: number) => void }) {
  const c = campaignsCopy;
  if (pages <= 1) return null;
  const from = page * PAGE_SIZE + 1;
  const to = Math.min(shown, (page + 1) * PAGE_SIZE);
  return (
    <nav data-testid="review-pager" aria-label={`${c.reviewPageWord} ${page + 1} ${c.reviewPageOf} ${pages}`} className="flex items-center gap-2">
      <span className="type-mono text-11 text-muted">
        {c.reviewShowing} {from}–{to} {c.reviewPageOf} {shown} {c.reviewAccountsWord}
      </span>
      <TextButton data-testid="page-prev" disabled={page === 0} onClick={() => onPage(page - 1)}>
        {c.reviewPagePrev}
      </TextButton>
      <TextButton data-testid="page-next" disabled={page >= pages - 1} onClick={() => onPage(page + 1)}>
        {c.reviewPageNext}
      </TextButton>
    </nav>
  );
}
