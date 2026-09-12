import Link from "next/link";

import { Card } from "@/components/Card";
import { sizeLine, whereLine } from "@/lib/campaigns/briefLines";
import type { BriefFields } from "@/lib/campaigns/types";
import { campaignsCopy, startCopy } from "@/lib/copy/campaigns";

/**
 * The brief, read only, with Edit brief (§23.1c, orchestrator A1 item 5).
 *
 * Read only is the whole design: there is no inline edit and no save. Its
 * rows are the card the rep confirmed on Start, and Who exactly's rows are
 * there only when the rep set them: the brief card never shows a constraint
 * research was not held to.
 *
 * Edit brief opens Start on this brief (`/campaigns/<id>/edit`). It replaces
 * "Change something" and its reason picker: the rep changes the brief's own
 * fields, and nothing has to read a reason. Offered only where the campaign
 * can take a new brief, which the caller decides.
 */

const MOTIONS: Record<BriefFields["motion"], string> = {
  direct: startCopy.motionDirect,
  channel: startCopy.motionChannel,
};

const CHANNELS: Record<BriefFields["channels"][number], string> = {
  email: startCopy.channelEmail,
  linkedin: startCopy.channelLinkedin,
  calls: startCopy.channelCalls,
};

export function BriefCard({
  brief,
  summary,
  editHref,
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
  /** Where Edit brief goes. Absent makes the card read only with no way to change it. */
  editHref?: string;
}) {
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

      {editHref === undefined ? null : (
        <div className="mt-3">
          <Link
            href={editHref}
            data-testid="edit-brief"
            className="inline-flex min-h-6 items-center rounded-pill text-13 font-semibold text-action focus-visible:outline-none focus-visible:ring-2"
          >
            {campaignsCopy.editBrief}
          </Link>
        </div>
      )}
    </Card>
  );
}
