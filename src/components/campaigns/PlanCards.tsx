"use client";

import Link from "next/link";
import { useState } from "react";

import { Card } from "@/components/Card";
import { campaignsCopy } from "@/lib/copy/campaigns";
import { cn } from "@/lib/utils";
import type { PlanCards as PlanView } from "../../../agents/research/output.schema";

import { PackItem, PackPhrase } from "./PackItem";

/**
 * "The plan, and the research behind it" (§23.1c) — five cards that ARE the
 * research surface. There is no separate research page.
 *
 * The type this takes is the research contract's own plan-card view
 * (`planCards(pack)`, research v3 §3 "Derived views") and nothing else: the
 * pack is the contract and the cards are a view over it, read by the research
 * module rather than by a second mapping here. The hook and the recipe are
 * for the chosen kind of buyer, and a pack without them draws those cards'
 * contents empty rather than inventing them.
 *
 * Two cards deliberately show the same items twice. "Who we found" holds each
 * group with its pains and phrases; "Their pain, in their words" is the same
 * items read quote first. That is a second VIEW, which the signed section
 * allows, and not a second extraction, which it forbids.
 *
 * Contradictions live on the fifth card beside the unknowns. The signed mock
 * draws four cards plus unknowns and never says where a contradiction goes;
 * they are put with the gaps because both are Relay saying what it does not
 * know, and dropping them would be the page quietly discarding a finding the
 * contract calls one (§5 rule 4).
 */

/**
 * A count and its word, singular or plural.
 *
 * The choice is made here rather than in the copy file, because copy is data:
 * a template function's strings hide in a closure where the plain-words sweep
 * cannot read them (`tests/lib/copy.test.ts`).
 */
function counted(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** A country as a rep says it, or the code itself when there is no spelling. */
function countryName(code: string): string {
  const names: Record<string, string> = campaignsCopy.countries;
  return names[code] ?? code;
}

/** How many distinct sources the pack cites, for the card meta lines. */
function sourceCount(pack: PlanView): number {
  const urls = new Set<string>();
  const add = (item: { evidence: { urls: string[] } } | undefined) => {
    if (item === undefined) return;
    for (const url of item.evidence.urls) urls.add(url);
  };
  for (const group of pack.archetypes) {
    group.pains.forEach(add);
    group.language.forEach(add);
  }
  add(pack.hook?.whyNow);
  for (const firm of pack.seedFirms) add(firm.signal);
  for (const contradiction of pack.contradictions) {
    add(contradiction.a);
    add(contradiction.b);
  }
  return urls.size;
}

function PlanCard({
  title,
  summary,
  meta,
  dashed = false,
  editHref,
  children,
}: {
  title: string;
  summary: string;
  meta: string;
  dashed?: boolean;
  editHref?: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div
      data-testid="plan-card"
      /*
        An open card takes the whole width, as the signed mock draws it
        (3b-ii). A pack item is a sentence with a source under it, and reading
        seven of them down a half-width column is the difference between the
        research being on the page and being available on the page.
      */
      className={cn(
        "rounded-input border border-line bg-ground p-4",
        open ? "wide:col-span-2" : null,
        dashed ? "border-dashed" : null,
      )}
    >
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="w-full text-left focus-visible:outline-none focus-visible:ring-2"
      >
        <span className="type-name block">{title}</span>
        <span className="type-small block text-muted">{summary}</span>
        <span className="type-small mt-1.5 block text-muted">
          {open ? campaignsCopy.planHide : campaignsCopy.planShow}
          {campaignsCopy.noteJoin}
          {meta}
        </span>
      </button>

      {open ? (
        <div data-testid="plan-card-body" className="mt-2.5 border-t border-line pt-2.5">
          {children}
          {editHref === undefined ? null : (
            <Link
              href={editHref}
              className="mt-2 inline-flex min-h-6 items-center rounded-pill text-13 font-semibold text-action focus-visible:outline-none focus-visible:ring-2"
            >
              {campaignsCopy.editBrief}
            </Link>
          )}
        </div>
      ) : null}
    </div>
  );
}

export function PlanCards({
  pack,
  editHref,
}: {
  pack: PlanView;
  /** Where Edit brief goes from an open card. Absent once there is no new brief to give (§23.1c). */
  editHref?: string;
}) {
  const c = campaignsCopy;
  const sources = sourceCount(pack);
  const pains = pack.archetypes.flatMap((group) => group.pains);
  const phrases = pack.archetypes.flatMap((group) => group.language);
  const quoted = pains.filter((pain) => pain.quote !== undefined);
  // The view's summary is the rep summary's lines; the first two lead the cards.
  const [lead = "", second = lead] = pack.summary;
  // The hook and the targeting recipe are for one kind of buyer; say which.
  const chosen = pack.archetypes.find((group) => group.id === pack.chosenArchetypeId);
  const forChosen =
    chosen === undefined ? null : (
      <p data-testid="plan-for" className="type-small mb-1.5 text-muted">
        {c.forGroup} {chosen.name}
      </p>
    );

  return (
    <div className="grid gap-chips wide:grid-cols-2">
      <PlanCard
        title={c.cardWho}
        summary={second}
        meta={`${counted(pack.archetypes.length, c.countGroup, c.countGroups)}${c.noteJoin}${counted(sources, c.countSource, c.fromSources)}`}
        editHref={editHref}
      >
        {pack.archetypes.map((group) => (
          <div key={group.id} data-testid="plan-group" className="mb-3">
            <p className="type-small font-semibold">{group.name}</p>
            <p className="type-small mb-1 text-muted">{group.situation}</p>
            {group.pains.map((pain) => (
              <PackItem key={pain.id} item={pain} />
            ))}
            {group.language.map((phrase) => (
              <PackPhrase key={phrase.id} phrase={phrase} />
            ))}
          </div>
        ))}
      </PlanCard>

      <PlanCard
        title={c.cardHook}
        summary={pack.hook?.text ?? ""}
        meta={`${pack.hook === undefined ? 0 : 1} ${c.countWhyNow}`}
        editHref={editHref}
      >
        {pack.hook === undefined ? null : (
          <>
            {forChosen}
            <p className="type-small mb-1.5">{pack.hook.text}</p>
            <p className="type-small font-semibold">{c.whyNow}</p>
            <PackItem item={pack.hook.whyNow} />
          </>
        )}
      </PlanCard>

      <PlanCard
        title={c.cardPain}
        summary={lead}
        meta={`${quoted.length + phrases.length} ${c.shownOf}`}
        editHref={editHref}
      >
        {quoted.map((pain) => (
          <PackItem key={`quote-${pain.id}`} item={pain} quoteFirst />
        ))}
        {phrases.map((phrase) => (
          <PackPhrase key={`say-${phrase.id}`} phrase={phrase} />
        ))}
      </PlanCard>

      <PlanCard
        title={c.cardFirms}
        summary={pack.seedFirms.map((firm) => firm.name).join(", ")}
        meta={counted(pack.seedFirms.length, c.countFirm, c.countFirms)}
        editHref={editHref}
      >
        {pack.seedFirms.map((firm) => (
          <div key={firm.id} data-testid="plan-firm" className="mb-2">
            <p className="type-small font-semibold">
              {firm.name}
              {firm.domain === undefined ? null : <span className="text-muted"> {firm.domain}</span>}
            </p>
            <PackItem item={firm.signal} />
          </div>
        ))}
        {pack.recipe === undefined ? null : <div className="mt-2">{forChosen}</div>}
        {pack.recipe === undefined ? null : (
          <dl className="type-small mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
            {([
              [c.fieldWho, pack.recipe.titles.join(", ")],
              [c.recipeSize, `${pack.recipe.sizeBand.min} ${c.recipeAnd} ${pack.recipe.sizeBand.max}`],
              [c.recipeWhere, [...pack.recipe.countries.map(countryName), ...(pack.recipe.locations ?? [])].join(", ")],
              [c.recipeIndustry, pack.recipe.industries.join(", ")],
              [c.recipeTriggers, pack.recipe.triggers.join(", ")],
            ] as [string, string][]).map(([label, value]) => (
              <div key={label} className="contents">
                <dt className="text-muted">{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
        )}
      </PlanCard>

      <PlanCard
        title={c.cardUnknowns}
        summary={pack.unknowns.map((unknown) => unknown.text).join(" ")}
        meta={`${counted(pack.unknowns.length, c.countUnknown, c.countUnknowns)}${c.noteJoin}${c.nothingGuessed}`}
        dashed
      >
        {pack.unknowns.map((unknown) => (
          <div key={unknown.id} data-testid="plan-unknown" className="mb-2">
            <p className="type-small">{unknown.text}</p>
            <p className="type-small text-muted">{KINDS[unknown.kind]}</p>
            <p className="type-small text-muted">
              {c.triedLabel} {unknown.queriesTried.join(", ")}
            </p>
          </div>
        ))}
        {pack.contradictions.length === 0 ? null : (
          <div className="mt-2 border-t border-line pt-2">
            <p className="type-small font-semibold">{c.cardContradictions}</p>
            {pack.contradictions.map((contradiction) => (
              <div key={contradiction.id} data-testid="plan-contradiction">
                <p className="type-small">{contradiction.text}</p>
                {contradiction.a === undefined ? null : <PackItem item={contradiction.a} />}
                {contradiction.b === undefined ? null : <PackItem item={contradiction.b} />}
              </div>
            ))}
          </div>
        )}
      </PlanCard>
    </div>
  );
}

const KINDS: Record<PlanView["unknowns"][number]["kind"], string> = {
  "not-found": campaignsCopy.kindNotFound,
  "confirmed-absent": campaignsCopy.kindConfirmedAbsent,
  unreadable: campaignsCopy.kindUnreadable,
  conflicting: campaignsCopy.kindConflicting,
  "out-of-budget": campaignsCopy.kindOutOfBudget,
};

/**
 * A partial plan says so (research outcome `partial`, orchestrator A1 item 2):
 * a limit ended the run, and the parts it did not write are named in a rep's
 * words rather than drawn as empty cards. A stopped pack is partial too, and
 * is the stop card's to explain, so it never gets this line.
 */
function PartialNote({ pack }: { pack: PlanView }) {
  if (!pack.partial || pack.insufficient !== undefined || pack.missingModules.length === 0) return null;
  const names: Record<string, string> = campaignsCopy.partNames;
  const missing = pack.missingModules.map((id) => names[id] ?? id).join(", ");
  return (
    <p data-testid="plan-partial" className="type-small mb-3 rounded-input bg-warn-bg px-3 py-2.5 text-warn">
      {campaignsCopy.planPartial} {missing}.
    </p>
  );
}

/**
 * The plan section, as one card with the five inside it (mock 3b).
 *
 * `collapsed` is the Running state (mock 3c): the page leads with progress and
 * the plan folds to its title with a "show". It is not hidden and it is not a
 * different plan; it is the same section, closed.
 */
export function PlanSection({
  pack,
  collapsed = false,
  editHref,
  children,
}: {
  pack: PlanView;
  collapsed?: boolean;
  editHref?: string;
  children?: React.ReactNode;
}) {
  const [open, setOpen] = useState(!collapsed);

  if (!collapsed) {
    return (
      <Card label={campaignsCopy.planLabel}>
        <PartialNote pack={pack} />
        <PlanCards pack={pack} editHref={editHref} />
        {children}
      </Card>
    );
  }

  return (
    <Card>
      <button
        type="button"
        aria-expanded={open}
        data-testid="plan-toggle"
        onClick={() => setOpen(!open)}
        className="flex w-full items-center justify-between gap-3 text-left focus-visible:outline-none focus-visible:ring-2"
      >
        <span className="type-label">{campaignsCopy.planLabel}</span>
        <span className="type-small text-muted">
          {open ? campaignsCopy.planHide : campaignsCopy.planShow}
        </span>
      </button>
      {open ? (
        <div className="mt-2.5">
          <PartialNote pack={pack} />
          <PlanCards pack={pack} editHref={editHref} />
          {children}
        </div>
      ) : null}
    </Card>
  );
}
