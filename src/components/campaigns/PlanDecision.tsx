"use client";

import { useState } from "react";

import { Card } from "@/components/Card";
import { Chip } from "@/components/Chip";
import type { CampaignOverview, ConfirmPlanView, PlayView } from "@/lib/campaigns/types";
import { campaignsCopy, startCopy } from "@/lib/copy/campaigns";
import { cn } from "@/lib/utils";

import { PackItem } from "./PackItem";

/**
 * Plan ready as a decision (product-truth pass): research found N plays and
 * recommends one; Confirm starts with it. The other plays are read as
 * research ranked them, compact, and can be picked. Confirming a play other
 * than the recommended one waits on the confirm contract that carries a play
 * (`choosePlay`): until then the pick is drawn, Confirm stays on the
 * recommended play, and the page says so in as many words.
 *
 * The full research is not here. It is one press away in the support rail
 * and on its own page; this card is what the rep decides on.
 */

const CHANNELS: Record<string, string> = {
  email: startCopy.channelEmail,
  linkedin: startCopy.channelLinkedin,
  calls: startCopy.channelCalls,
};

export function playsLine(count: number): string {
  const c = campaignsCopy;
  return `${c.playsFoundLead} ${count} ${count === 1 ? c.playsFoundOne : c.playsFoundMany}.`;
}

function Roles({ roles }: { roles: PlayView["roles"] }) {
  const c = campaignsCopy;
  return (
    <>
      {(["runs", "champions", "signs"] as const).map((part) => {
        const titles = roles.filter((role) => role.part === part).map((role) => role.title);
        return titles.length === 0 ? null : (
          <span key={part} className="mr-3 inline-block">
            <span className="text-muted">{c.roleParts[part]}:</span> {titles.join(", ")}
          </span>
        );
      })}
    </>
  );
}

function Recommended({ play, selected }: { play: PlayView; selected: boolean }) {
  const c = campaignsCopy;
  const rows: [string, React.ReactNode][] = [
    [c.playsWhyFirst, play.angle],
    [c.startWhyNow, play.whyNow],
    [
      c.playsWho,
      <>
        {play.groupName}
        {play.sizeRange === "" ? null : <span className="text-muted"> · {play.sizeRange}</span>}
        <span className="mt-0.5 block">
          <Roles roles={play.roles} />
        </span>
      </>,
    ],
    ...(play.pain === null ? [] : [[c.playsPain, <PackItem key="pain" item={play.pain} quoteFirst />] as [string, React.ReactNode]]),
    [c.startWrongIf, play.wrongIf],
    ...(play.firms.length === 0 ? [] : [[c.playsFirms, play.firms.join(", ")] as [string, React.ReactNode]]),
    [c.startChannels, play.channels.map((channel) => CHANNELS[channel] ?? channel).join(", ")],
  ];
  return (
    <section data-testid="play-recommended" aria-current={selected ? "true" : undefined} className={cn("rounded-input border p-3", selected ? "border-action bg-soft/40" : "border-line")}>
      <div className="mb-1.5 flex flex-wrap items-center gap-2">
        <Chip tone="ok">{c.playsRecommendedLabel}</Chip>
        {selected ? <span className="type-small text-action">{c.playsSelected}</span> : null}
      </div>
      <h3 className="type-name mb-2">{play.groupName}</h3>
      <dl className="grid grid-cols-1 gap-x-3 gap-y-1.5 wide:grid-cols-[auto_minmax(0,1fr)]">
        {rows.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="type-small font-semibold">{label}</dt>
            <dd className="type-small min-w-0 [overflow-wrap:anywhere]">{value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function Alternative({ play, selected, onSelect }: { play: PlayView; selected: boolean; onSelect: () => void }) {
  const c = campaignsCopy;
  const [open, setOpen] = useState(false);
  return (
    <li data-testid="play-alternative" aria-current={selected ? "true" : undefined} className={cn("min-w-0 rounded-input border p-3", selected ? "border-action bg-soft/40" : "border-line bg-ground")}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <p className="type-small">
            <span className="type-mono mr-1.5 text-11 text-muted">
              {c.playsRank} {play.rank}
            </span>
            <span className="font-semibold">{play.groupName}</span>
            {selected ? <span className="ml-1.5 text-action">{c.playsSelected}</span> : null}
          </p>
          <p className="type-small mt-0.5 text-muted [overflow-wrap:anywhere]">{play.angle}</p>
        </div>
        <button
          type="button"
          data-testid="play-select"
          aria-pressed={selected}
          onClick={onSelect}
          className={cn(
            "type-small inline-flex min-h-7 shrink-0 items-center rounded-pill border px-3 font-semibold focus-visible:outline-none focus-visible:ring-2",
            selected ? "border-transparent bg-action text-on-action" : "border-line text-action",
          )}
        >
          {c.playsSelect}
        </button>
      </div>
      <button
        type="button"
        aria-expanded={open}
        data-testid="play-more"
        onClick={() => setOpen(!open)}
        className="type-small mt-1.5 inline-flex min-h-6 items-center font-semibold text-action focus-visible:outline-none focus-visible:ring-2"
      >
        {open ? c.overviewHide : c.overviewShow} {c.playsDetail}
      </button>
      {open ? (
        <dl className="mt-1.5 grid grid-cols-1 gap-x-3 gap-y-1 wide:grid-cols-[auto_minmax(0,1fr)]">
          <dt className="type-small font-semibold">{c.startWhyNow}</dt>
          <dd className="type-small [overflow-wrap:anywhere]">{play.whyNow}</dd>
          <dt className="type-small font-semibold">{c.playsWho}</dt>
          <dd className="type-small">
            <Roles roles={play.roles} />
          </dd>
          {play.pain === null ? null : (
            <>
              <dt className="type-small font-semibold">{c.playsPain}</dt>
              <dd className="type-small">
                <PackItem item={play.pain} quoteFirst />
              </dd>
            </>
          )}
          <dt className="type-small font-semibold">{c.startWrongIf}</dt>
          <dd className="type-small [overflow-wrap:anywhere]">{play.wrongIf}</dd>
        </dl>
      ) : null}
    </li>
  );
}

export function PlanDecision({
  overview,
  confirmPlan,
  selectedPlayId,
  onSelect,
  choosePlay = false,
}: {
  overview: CampaignOverview;
  confirmPlan: ConfirmPlanView | null;
  /** The play Confirm will start with: the rep's pick, or the recommended one. */
  selectedPlayId: string | null;
  onSelect: (playId: string) => void;
  /** Confirm can carry a play other than the recommended one. */
  choosePlay?: boolean;
}) {
  const c = campaignsCopy;
  const plays = overview.plays;
  const recommended = plays.find((play) => play.recommended) ?? null;
  const others = plays.filter((play) => !play.recommended);
  const selected = plays.find((play) => play.id === selectedPlayId) ?? recommended;
  const offRecommended = selected !== null && recommended !== null && selected.id !== recommended.id;

  return (
    <Card label={c.planLabel}>
      <div data-testid="plan-decision" className="grid min-w-0 gap-4 [overflow-wrap:anywhere]">
        <div>
          <p data-testid="plays-found" className="type-body-large">
            {playsLine(plays.length)} {plays.length > 1 ? c.playsRecommends : ""}
          </p>
          <p className="type-small mt-0.5 text-muted">
            {c.basedOn} {overview.sources} {overview.sources === 1 ? c.countSource : c.fromSources}
          </p>
        </div>

        {recommended === null ? null : <Recommended play={recommended} selected={selected?.id === recommended.id} />}

        {others.length === 0 ? null : (
          <section data-testid="plays-alternatives">
            <h3 className="type-label mb-1.5">{c.playsAlternativesLabel}</h3>
            <ul className="grid gap-2">
              {others.map((play) => (
                <Alternative key={play.id} play={play} selected={selected?.id === play.id} onSelect={() => onSelect(play.id)} />
              ))}
            </ul>
            {offRecommended && recommended !== null ? (
              <button
                type="button"
                data-testid="play-select-recommended"
                onClick={() => onSelect(recommended.id)}
                className="type-small mt-2 inline-flex min-h-6 items-center font-semibold text-action focus-visible:outline-none focus-visible:ring-2"
              >
                {c.playsSelectRecommended}
              </button>
            ) : null}
          </section>
        )}

        {confirmPlan === null ? null : (
          <section data-testid="confirm-card" className="border-t border-line pt-3">
            <h3 className="type-label mb-1.5">{c.confirmDoesLabel}</h3>
            <p data-testid="confirm-starts-with" className="type-small mb-1.5">
              <span className="font-semibold">{c.confirmStartsWith}</span> {selected?.groupName ?? confirmPlan.groupName ?? ""}
            </p>
            <ul className="grid gap-1">
              <li className="type-small">{c.confirmDoesFreeze}</li>
              {confirmPlan.available && confirmPlan.searchCreditCap !== null ? (
                <li className="type-small" data-testid="confirm-cap">
                  {c.confirmDoesSearch} {confirmPlan.searchCreditCap} {c.confirmCredits}.
                </li>
              ) : null}
              <li className="type-small">{c.confirmDoesNothing}</li>
            </ul>
            <p className="type-small mt-1.5 text-muted">
              <span className="font-semibold">{c.confirmLawful}:</span> <span data-testid="confirm-lawful">{confirmPlan.lawfulBasis}</span>
            </p>
            {confirmPlan.available && confirmPlan.sample ? (
              <p data-testid="confirm-sample" className="type-small mt-1.5 text-warn">
                {c.confirmSample}
              </p>
            ) : null}
            {offRecommended && !choosePlay ? (
              <p data-testid="confirm-play-later" className="type-small mt-1.5 rounded-input bg-warn-bg px-3 py-2 text-warn">
                {c.playsChooseLater}
              </p>
            ) : null}
          </section>
        )}
      </div>
    </Card>
  );
}
