"use client";

import { useState } from "react";

import { Card } from "@/components/Card";
import { Chip } from "@/components/Chip";
import type { CampaignOverview, ConfirmPlanView, ResearchPlayView } from "@/lib/campaigns/types";
import { campaignsCopy, startCopy } from "@/lib/copy/campaigns";
import { cn } from "@/lib/utils";

import { PackItem } from "./PackItem";

/**
 * Plan ready as a decision (product-truth pass, on the backend's plays):
 * research found N plays it could rank, recommends the first, and Confirm
 * freezes the one the rep names (`candidateId`, lead gen v2.3). Rank 1 is
 * selected until the rep picks another. A play research gave no search for
 * can be read but not confirmed, and says so.
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

function Roles({ roles }: { roles: ResearchPlayView["roles"] }) {
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

type GroupDetail = { sizeRange: string; situation: string } | null;

function Recommended({ play, group, pain, selected }: { play: ResearchPlayView; group: GroupDetail; pain: CampaignOverview["pain"]; selected: boolean }) {
  const c = campaignsCopy;
  const firstPain = pain?.pains[0] ?? null;
  const rows: [string, React.ReactNode][] = [
    [c.playsWhyFirst, play.leadAngle],
    [c.startWhyNow, play.whyNow],
    [
      c.playsWho,
      <>
        {play.group.name}
        {group === null || group.sizeRange === "" ? null : <span className="text-muted"> · {group.sizeRange}</span>}
        <span className="mt-0.5 block">
          <Roles roles={play.roles} />
        </span>
      </>,
    ],
    ...(firstPain === null ? [] : [[c.playsPain, <PackItem key="pain" item={firstPain} quoteFirst />] as [string, React.ReactNode]]),
    [c.startWrongIf, play.wrongIf],
    ...(play.seedFirms.length === 0 ? [] : [[c.playsFirms, play.seedFirms.join(", ")] as [string, React.ReactNode]]),
    [c.startChannels, play.channels.map((channel) => CHANNELS[channel] ?? channel).join(", ")],
  ];
  return (
    <section data-testid="play-recommended" aria-current={selected ? "true" : undefined} className={cn("rounded-input border p-3", selected ? "border-action bg-soft/40" : "border-line")}>
      <div className="mb-1.5 flex flex-wrap items-center gap-2">
        <Chip tone="ok">{c.playsRecommendedLabel}</Chip>
        {selected ? <span className="type-small text-action">{c.playsSelected}</span> : null}
      </div>
      <h3 className="type-name mb-2">{play.group.name}</h3>
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

function Alternative({ play, group, selected, onSelect }: { play: ResearchPlayView; group: GroupDetail; selected: boolean; onSelect: () => void }) {
  const c = campaignsCopy;
  const [open, setOpen] = useState(false);
  return (
    <li
      data-testid="play-alternative"
      data-executable={play.executable}
      aria-current={selected ? "true" : undefined}
      className={cn("min-w-0 rounded-input border p-3", selected ? "border-action bg-soft/40" : "border-line bg-ground")}
    >
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 sm:flex-1">
          <p className="type-small">
            <span className="type-mono mr-1.5 text-11 text-muted">
              {c.playsRank} {play.rank}
            </span>
            <span className="font-semibold">{play.group.name}</span>
            {selected ? <span className="ml-1.5 text-action">{c.playsSelected}</span> : null}
          </p>
          <p className="type-small mt-0.5 text-muted [overflow-wrap:anywhere]">{play.leadAngle}</p>
        </div>
        {play.executable ? (
          <button
            type="button"
            data-testid="play-select"
            aria-pressed={selected}
            onClick={onSelect}
            className={cn(
              "type-small inline-flex min-h-7 shrink-0 items-center self-start rounded-pill border px-3 font-semibold focus-visible:outline-none focus-visible:ring-2",
              selected ? "border-transparent bg-action text-on-action" : "border-line text-action",
            )}
          >
            {c.playsSelect}
          </button>
        ) : (
          <Chip>{c.playsSelectDisabled}</Chip>
        )}
      </div>
      {play.executable ? null : (
        <p data-testid="play-not-searchable" className="type-small mt-1.5 text-muted">
          {c.playsNotSearchable}
        </p>
      )}
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
            {group === null || group.sizeRange === "" ? null : <span className="text-muted">{group.sizeRange} · </span>}
            <Roles roles={play.roles} />
          </dd>
          {group === null || group.situation === "" ? null : (
            <>
              <dt className="type-small font-semibold">{c.playsSituation}</dt>
              <dd className="type-small [overflow-wrap:anywhere]">{group.situation}</dd>
            </>
          )}
          <dt className="type-small font-semibold">{c.startWrongIf}</dt>
          <dd className="type-small [overflow-wrap:anywhere]">{play.wrongIf}</dd>
          {play.seedFirms.length === 0 ? null : (
            <>
              <dt className="type-small font-semibold">{c.playsFirms}</dt>
              <dd className="type-small">{play.seedFirms.join(", ")}</dd>
            </>
          )}
        </dl>
      ) : null}
    </li>
  );
}

export function PlanDecision({
  plays,
  overview,
  confirmPlan,
  selectedId,
  onSelect,
}: {
  plays: readonly ResearchPlayView[];
  overview: CampaignOverview;
  confirmPlan: ConfirmPlanView | null;
  /** The play Confirm will name: the rep's pick, or the recommended one. */
  selectedId: string | null;
  onSelect: (candidateId: string) => void;
}) {
  const c = campaignsCopy;
  const recommended = plays.find((play) => play.recommended) ?? null;
  const others = plays.filter((play) => !play.recommended);
  const selected = plays.find((play) => play.id === selectedId) ?? recommended;
  const offRecommended = selected !== null && recommended !== null && selected.id !== recommended.id;
  const groupOf = (play: ResearchPlayView): GroupDetail => {
    const group = overview.groups.find((entry) => entry.id === play.group.id);
    return group === undefined ? null : { sizeRange: group.sizeRange, situation: group.situation };
  };
  const searchable = plays.filter((play) => play.executable).length;

  return (
    <Card label={c.planLabel}>
      <div data-testid="plan-decision" className="grid min-w-0 gap-4 [overflow-wrap:anywhere]">
        <div>
          <p data-testid="plays-found" className="type-body-large">
            {playsLine(plays.length)} {plays.length > 1 ? c.playsRecommends : ""}
          </p>
          <p className="type-small mt-0.5 text-muted">
            {c.basedOn} {overview.sources} {overview.sources === 1 ? c.countSource : c.fromSources}
            {searchable < plays.length ? `${c.noteJoin}${searchable} ${c.playsSearchable}` : ""}
          </p>
        </div>

        {recommended === null ? null : <Recommended play={recommended} group={groupOf(recommended)} pain={overview.pain} selected={selected?.id === recommended.id} />}

        {others.length === 0 ? null : (
          <section data-testid="plays-alternatives">
            <h3 className="type-label mb-1.5">{c.playsAlternativesLabel}</h3>
            <ul className="grid gap-2">
              {others.map((play) => (
                <Alternative key={play.id} play={play} group={groupOf(play)} selected={selected?.id === play.id} onSelect={() => onSelect(play.id)} />
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
              <span className="font-semibold">{c.confirmStartsWith}</span> {selected?.group.name ?? confirmPlan.groupName ?? ""}
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
          </section>
        )}
      </div>
    </Card>
  );
}
