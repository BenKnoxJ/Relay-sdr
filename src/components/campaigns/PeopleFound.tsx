import { Card } from "@/components/Card";
import { Chip } from "@/components/Chip";
import type { PeopleFoundView } from "@/lib/campaigns/types";
import { campaignsCopy } from "@/lib/copy/campaigns";

/**
 * People found (lead gen v2.1 §4, §11): the persisted candidates, X of N,
 * why a partial search ended short, what the search spent from the ledger,
 * and what revealing their emails would use. Reveal itself is the page's
 * header action and is not pressable yet. Reused people are marked: Relay
 * already holds their email.
 */
export function PeopleFound({ view, editHref, spent }: { view: PeopleFoundView; editHref?: string; spent: boolean }) {
  const c = campaignsCopy;
  return (
    <Card label={c.peopleFoundLabel}>
      <div data-testid="people-found">
        <p data-testid="found-count" className="type-name">
          {view.found.n} {c.peopleFoundOf} {view.found.ofM}
        </p>
        <p className="type-small text-muted">
          {c.peopleFoundFor} {view.groupName}
        </p>
        {view.shortfall === null ? null : (
          <p data-testid="shortfall" className="type-small mt-1.5 text-warn">
            {view.shortfall === "cap_reached" ? c.shortfallCapReached : c.shortfallNoMore}
          </p>
        )}

        <ol className="mt-3 grid gap-2 border-t border-line pt-3">
          {view.people.map((person) => (
            <li key={person.id} data-testid="found-person" className="flex items-start gap-3">
              <span className="type-mono w-5 shrink-0 text-11 text-muted">{person.rank}</span>
              <span className="min-w-0 flex-1">
                <b className="type-name block text-14">
                  {person.name} · {person.title}
                </b>
                <span className="type-small block text-muted">{[person.company, person.city].filter((part) => part !== null).join(" · ")}</span>
                <span className="type-small block">{person.whyPicked}</span>
              </span>
              {person.reused ? <Chip tone="ok">{c.peopleReusedChip}</Chip> : null}
            </li>
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
            {c.revealAbout} {view.revealEstimate.credits} {c.revealCredits}
            {view.revealEstimate.reused > 0 ? ` ${view.revealEstimate.reused} ${c.revealReused}` : ""}
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
