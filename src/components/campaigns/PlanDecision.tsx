"use client";

import { Card } from "@/components/Card";
import { PillButton } from "@/components/PillButton";
import { TextButton } from "@/components/TextButton";
import type { CampaignOverview, ConfirmPlanView, ResearchPlayView } from "@/lib/campaigns/types";
import { campaignsCopy, startCopy } from "@/lib/copy/campaigns";
import { cn } from "@/lib/utils";

import { PackItem } from "./PackItem";

/**
 * Plan ready as a decision (product-truth pass, on the backend's plays; final
 * MVP pass): research found N plays it could rank and recommends the first.
 * Where there is more than one, a comparison table puts every play's Who,
 * Why now and Wrong if side by side, one press selects a play, and one card
 * under the table reads the selected play in full. Confirm freezes the one
 * the rep names (`candidateId`, lead gen v2.3). A play research gave no
 * search for can be read but not confirmed, and says so.
 *
 * On the campaign research ran on, each play that can be searched also has
 * a tick box: the ticked plays become a campaign each (Relay P1), and each is
 * then confirmed on its own.
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

/** The roles in one phrase, who runs it first: "Head of Claims · Claims Director". */
function rolesLine(roles: ResearchPlayView["roles"]): string {
  const c = campaignsCopy;
  return (["runs", "champions", "signs"] as const)
    .flatMap((part) => roles.filter((role) => role.part === part).map((role) => `${c.roleParts[part]}: ${role.title}`))
    .join(c.noteJoin);
}

type GroupDetail = { sizeRange: string; situation: string } | null;

/** Who, in one line for the table: the kind of buyer's size, and who runs the problem there. */
function whoShort(play: ResearchPlayView, group: GroupDetail): string {
  const c = campaignsCopy;
  const runs = play.roles.filter((role) => role.part === "runs").map((role) => role.title);
  const parts = [...(group === null || group.sizeRange === "" ? [] : [group.sizeRange]), ...(runs.length === 0 ? [] : [`${c.roleParts.runs}: ${runs.join(", ")}`])];
  return parts.join(c.noteJoin);
}

/** Ticking plays to make a campaign each (Relay P1); null where plays cannot be ticked. */
export type PlayPick = {
  ticked: readonly string[];
  onTick: (id: string) => void;
  onCreate: () => void;
  pending: boolean;
  error: string | null;
};

function Compare({
  plays,
  groupOf,
  selectedId,
  onSelect,
  pick,
}: {
  plays: readonly ResearchPlayView[];
  groupOf: (play: ResearchPlayView) => GroupDetail;
  selectedId: string | null;
  onSelect: (id: string) => void;
  pick: PlayPick | null;
}) {
  const c = campaignsCopy;
  return (
    <section data-testid="plays-compare" aria-label={c.playsCompareLabel} className="min-w-0">
      <h3 className="type-label mb-1.5">{c.playsCompareLabel}</h3>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[560px] border-collapse">
          <thead>
            <tr className="border-b border-line text-left">
              {[c.playsColumnPlay, c.playsColumnWho, c.playsColumnWrongIf].map((column) => (
                <th key={column} scope="col" className="type-label pb-1.5 pr-3 font-medium">
                  {column}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {plays.map((play) => {
              const selected = play.id === selectedId;
              return (
                <tr
                  key={play.id}
                  data-testid={play.recommended ? "play-recommended-row" : "play-alternative"}
                  data-executable={play.executable}
                  aria-current={selected ? "true" : undefined}
                  className={cn("border-b border-line align-top last:border-b-0", selected ? "bg-soft/40" : "")}
                >
                  <td className="w-[28%] min-w-[160px] py-2 pr-3">
                    {pick !== null && play.executable ? (
                      <input
                        type="checkbox"
                        data-testid="play-tick"
                        aria-label={`${c.playsTick} ${play.group.name}`}
                        checked={pick.ticked.includes(play.id)}
                        disabled={pick.pending}
                        onChange={() => pick.onTick(play.id)}
                        className="mr-2 align-middle"
                      />
                    ) : null}
                    {play.executable ? (
                      <button
                        type="button"
                        data-testid="play-select"
                        aria-pressed={selected}
                        onClick={() => onSelect(play.id)}
                        className="type-small text-left font-semibold text-ink focus-visible:outline-none focus-visible:ring-2"
                      >
                        <span className="type-mono mr-1.5 text-11 text-muted">{play.rank}</span>
                        {play.group.name}
                      </button>
                    ) : (
                      <span className="type-small block font-semibold text-muted">
                        <span className="type-mono mr-1.5 text-11">{play.rank}</span>
                        {play.group.name}
                      </span>
                    )}
                    <span className="type-mono mt-0.5 block text-11 text-muted">
                      {play.recommended ? c.playsRecommendedLabel : ""}
                      {play.recommended && selected ? " · " : ""}
                      {selected ? <span className="text-action">{c.playsSelected}</span> : null}
                      {play.executable ? "" : `${play.recommended || selected ? " · " : ""}${c.playsSelectDisabled}`}
                    </span>
                  </td>
                  <td className="w-[30%] py-2 pr-3">
                    <span className="type-small block text-12">{whoShort(play, groupOf(play))}</span>
                  </td>
                  <td className="w-[42%] py-2">
                    <span className="type-small block text-12 [overflow-wrap:anywhere]">{play.wrongIf}</span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/** The selected play in full, Who first: what the rep is confirming. */
function Detail({ play, group, pain }: { play: ResearchPlayView; group: GroupDetail; pain: CampaignOverview["pain"] }) {
  const c = campaignsCopy;
  const firstPain = play.recommended ? (pain?.pains[0] ?? null) : null;
  const rows: [string, React.ReactNode][] = [
    [
      c.playsWho,
      <>
        <span className="font-semibold">{play.group.name}</span>
        {group === null || group.sizeRange === "" ? null : <span className="text-muted"> · {group.sizeRange}</span>}
        <span className="mt-0.5 block">{rolesLine(play.roles)}</span>
        {group === null || group.situation === "" ? null : <span className="mt-0.5 block text-muted">{group.situation}</span>}
      </>,
    ],
    [c.startWhyNow, play.whyNow],
    [c.startWrongIf, play.wrongIf],
    [c.playsWhyFirst, play.leadAngle],
    ...(firstPain === null ? [] : [[c.playsPain, <PackItem key="pain" item={firstPain} quoteFirst />] as [string, React.ReactNode]]),
    ...(play.seedFirms.length === 0 ? [] : [[c.playsFirms, play.seedFirms.join(", ")] as [string, React.ReactNode]]),
    [c.startChannels, play.channels.map((channel) => CHANNELS[channel] ?? channel).join(", ")],
  ];
  return (
    <section data-testid={play.recommended ? "play-recommended" : "play-detail"} data-rank={play.rank} className="border-t border-line pt-3">
      <p className="type-label mb-1.5">
        {c.playsDetailLabel}
        <span className="type-mono ml-2 text-11 font-normal text-muted">
          {c.playsSelectedRank} {play.rank}
          {play.recommended ? ` · ${c.playsRecommendedLabel}` : ""}
        </span>
      </p>
      <h3 className="type-name mb-2">{play.group.name}</h3>
      <dl className="grid max-w-measure grid-cols-1 gap-x-3 gap-y-1.5 wide:max-w-none wide:grid-cols-[auto_minmax(0,1fr)]">
        {rows.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="type-small font-semibold">{label}</dt>
            <dd className="type-small min-w-0 max-w-measure [overflow-wrap:anywhere]">{value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

export function PlanDecision({
  plays,
  overview,
  confirmPlan,
  selectedId,
  onSelect,
  pick = null,
}: {
  plays: readonly ResearchPlayView[];
  overview: CampaignOverview;
  confirmPlan: ConfirmPlanView | null;
  /** The play Confirm will name: the rep's pick, or the recommended one. */
  selectedId: string | null;
  onSelect: (candidateId: string) => void;
  pick?: PlayPick | null;
}) {
  const c = campaignsCopy;
  const recommended = plays.find((play) => play.recommended) ?? null;
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
          <p data-testid="plays-found" className="type-body-large max-w-measure">
            {playsLine(plays.length)} {plays.length > 1 ? c.playsRecommends : ""}
          </p>
          <p className="type-small mt-0.5 text-muted">
            {c.basedOn} {overview.sources} {overview.sources === 1 ? c.countSource : c.fromSources}
            {searchable < plays.length ? `${c.noteJoin}${searchable} ${c.playsSearchable}` : ""}
          </p>
        </div>

        {plays.length > 1 ? <Compare plays={plays} groupOf={groupOf} selectedId={selected?.id ?? null} onSelect={onSelect} pick={pick} /> : null}

        {pick === null ? null : (
          <div data-testid="plays-create" className="-mt-2 flex flex-wrap items-center gap-3">
            <PillButton variant="outline" disabled={pick.ticked.length === 0 || pick.pending} onClick={pick.onCreate}>
              {pick.pending ? c.playsCreating : c.playsCreate}
            </PillButton>
            <span className="type-small max-w-measure text-muted">{c.playsCreateNote}</span>
            {pick.error === null ? null : (
              <p role="alert" data-testid="plays-create-error" className="type-small basis-full text-warn">
                {pick.error}
              </p>
            )}
          </div>
        )}

        {selected === null ? null : <Detail play={selected} group={groupOf(selected)} pain={overview.pain} />}
        {offRecommended && recommended !== null ? (
          <TextButton data-testid="play-select-recommended" onClick={() => onSelect(recommended.id)} className="-mt-2 justify-self-start">
            {c.playsSelectRecommended}
          </TextButton>
        ) : null}

        {confirmPlan === null ? null : (
          <section data-testid="confirm-card" className="border-t border-line pt-3">
            <h3 className="type-label mb-1.5">{c.confirmDoesLabel}</h3>
            <p data-testid="confirm-starts-with" className="type-small mb-1.5">
              <span className="font-semibold">{c.confirmStartsWith}</span> {selected?.group.name ?? confirmPlan.groupName ?? ""}
            </p>
            <ul className="grid max-w-measure gap-1">
              <li className="type-small">{c.confirmDoesFreeze}</li>
              {confirmPlan.available && confirmPlan.searchCreditCap !== null ? (
                <li className="type-small" data-testid="confirm-cap">
                  {c.confirmDoesSearch} {confirmPlan.searchCreditCap} {c.confirmCredits}.
                </li>
              ) : null}
              <li className="type-small">{c.confirmDoesNothing}</li>
            </ul>
            <p className="type-small mt-1.5 max-w-measure text-muted">
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
