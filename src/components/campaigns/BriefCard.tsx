"use client";

import { useState } from "react";

import { Card } from "@/components/Card";
import { PillButton } from "@/components/PillButton";
import { countryName } from "@/lib/campaigns/start";
import type { BriefFields } from "@/lib/campaigns/types";
import { campaignsCopy, startCopy } from "@/lib/copy/campaigns";

/**
 * The brief, read only, with "Change something" (§23.1c).
 *
 * Read only is the whole design: there is no inline edit and no save. Its
 * rows are the card the rep confirmed on Start, and Who exactly's rows are
 * there only when the rep set them: the brief card never shows a constraint
 * research was not held to.
 *
 * "Change something" is offered only where there is a way to change: on the
 * sample campaigns today. A real campaign's brief is changed through Edit
 * brief, which arrives with the next change.
 */

const REASONS = [
  campaignsCopy.changeReasonWho,
  campaignsCopy.changeReasonPain,
  campaignsCopy.changeReasonRegion,
  campaignsCopy.changeReasonSize,
  campaignsCopy.changeReasonOther,
];

const MOTIONS: Record<BriefFields["motion"], string> = {
  direct: startCopy.motionDirect,
  channel: startCopy.motionChannel,
};

const CHANNELS: Record<BriefFields["channels"][number], string> = {
  email: startCopy.channelEmail,
  linkedin: startCopy.channelLinkedin,
  calls: startCopy.channelCalls,
};

/** "5 to 50 people employed", "at least 3 sites", "at most 40 seats". */
function sizeLine(size: NonNullable<BriefFields["scope"]["size"]>): string {
  const unit = campaignsCopy.sizeUnits[size.unit];
  if (size.min !== undefined && size.max !== undefined) return `${size.min} ${campaignsCopy.sizeTo} ${size.max} ${unit}`;
  if (size.min !== undefined) return `${campaignsCopy.sizeAtLeast} ${size.min} ${unit}`;
  return `${campaignsCopy.sizeAtMost} ${size.max} ${unit}`;
}

/** Where: the region, the countries added to it, and the places, each by name. */
function whereLine(brief: BriefFields): string {
  const places = brief.scope.places.map((place) =>
    place.aliases.length === 0 ? place.name : `${place.name} (${campaignsCopy.alsoCalled} ${place.aliases.join(", ")})`,
  );
  return [countryName(brief.region), ...brief.scope.extraCountries.map(countryName), ...places].join(", ");
}

export function BriefCard({
  brief,
  summary,
  open = false,
  about,
  onOpenChange,
  onChange,
}: {
  brief: BriefFields;
  /**
   * The one-line spelling of the brief, for the rail.
   *
   * The signed mock draws the brief twice: the fields in the main column while
   * the plan is the screen (3b), and one grey line on the rail once the
   * campaign is running and progress has the column (3c).
   */
  summary?: string;
  /**
   * Whether the reason dialog is showing. The page owns it, not this card:
   * "Change something about this…" on a plan card opens the same dialog.
   */
  open?: boolean;
  /** Pre-filled when the rep came from a plan card ("Change something about this…"). */
  about?: string | null;
  onOpenChange?: (open: boolean) => void;
  /** Absent makes the card read only with no way to change it. */
  onChange?: (reason: string, note: string) => void;
}) {
  const [reason, setReason] = useState<string | null>(null);
  const [note, setNote] = useState("");

  /** Close, and forget what was typed: a reopened dialog asks again. */
  const close = () => {
    setReason(null);
    setNote("");
    onOpenChange?.(false);
  };

  const scope = brief.scope;
  const fields: [string, string][] = [
    [campaignsCopy.fieldProduct, brief.product],
    [campaignsCopy.fieldMotion, MOTIONS[brief.motion]],
    [campaignsCopy.fieldWho, brief.who],
    [campaignsCopy.fieldWhere, whereLine(brief)],
    ...(scope.orgTypes.length === 0 ? [] : [[campaignsCopy.fieldOrgTypes, scope.orgTypes.join(", ")] as [string, string]]),
    ...(scope.size === null ? [] : [[campaignsCopy.fieldSize, sizeLine(scope.size)] as [string, string]]),
    ...(scope.rolesInclude.length === 0 ? [] : [[campaignsCopy.fieldRolesInclude, scope.rolesInclude.join(", ")] as [string, string]]),
    ...(scope.rolesExclude.length === 0 ? [] : [[campaignsCopy.fieldRolesExclude, scope.rolesExclude.join(", ")] as [string, string]]),
    [
      campaignsCopy.fieldHowMany,
      `${brief.howMany} ${startCopy.people} ${campaignsCopy.over} ${brief.weeks} ${startCopy.weeks}`,
    ],
    [campaignsCopy.fieldChannels, brief.channels.map((channel) => CHANNELS[channel]).join(", ")],
    ...(brief.existingCustomers.trim() === "" ? [] : [[campaignsCopy.fieldCustomers, brief.existingCustomers] as [string, string]]),
  ];

  return (
    <Card label={campaignsCopy.briefLabel}>
      {summary === undefined ? (
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5">
          {fields.map(([label, value]) => (
            <div key={label} data-testid="brief-field" className="contents">
              <dt className="type-small text-muted">{label}</dt>
              <dd className="type-small">{value}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className="type-small text-muted">{summary}</p>
      )}

      {onChange === undefined ? null : (
        <div className="mt-3">
          <PillButton variant="text" className="text-action" onClick={() => onOpenChange?.(true)}>
            {campaignsCopy.changeSomething}
          </PillButton>
        </div>
      )}

      {open && onChange !== undefined ? (
        <div data-testid="change-dialog" role="dialog" aria-label={campaignsCopy.changeTitle} className="mt-3 rounded-input border border-line bg-ground p-4">
          <p className="type-name">{campaignsCopy.changeTitle}</p>
          <p className="type-small mb-2.5 text-muted">{campaignsCopy.changeHint}</p>
          {about === undefined || about === null ? null : (
            <p className="type-small mb-2.5">{about}</p>
          )}

          <div className="mb-3 flex flex-wrap gap-chips">
            {REASONS.map((option) => (
              <button
                key={option}
                type="button"
                data-testid="change-reason"
                aria-pressed={reason === option}
                onClick={() => setReason(option)}
                className={
                  reason === option
                    ? "rounded-pill border border-transparent bg-soft px-3 py-1 text-13 text-action focus-visible:outline-none focus-visible:ring-2"
                    : "rounded-pill border border-line bg-panel px-3 py-1 text-13 text-muted focus-visible:outline-none focus-visible:ring-2"
                }
              >
                {option}
              </button>
            ))}
          </div>

          <label className="type-small block text-muted" htmlFor="change-note">
            {campaignsCopy.changeNoteLabel}
          </label>
          <textarea
            id="change-note"
            value={note}
            onChange={(event) => setNote(event.target.value)}
            placeholder={campaignsCopy.changeNotePlaceholder}
            className="type-small mb-3 mt-1 w-full rounded-input border-control border-line bg-panel px-3 py-2 focus-visible:outline-none focus-visible:ring-2"
          />

          <div className="flex gap-chips">
            <PillButton
              disabled={reason === null}
              onClick={() => {
                if (reason === null) return;
                onChange(reason, note);
                close();
              }}
            >
              {campaignsCopy.changeSubmit}
            </PillButton>
            <PillButton variant="text" onClick={close}>
              {campaignsCopy.changeCancel}
            </PillButton>
          </div>
        </div>
      ) : null}
    </Card>
  );
}
