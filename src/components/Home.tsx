import Link from "next/link";

import type { CampaignSummary } from "@/lib/campaigns/types";
import { campaignsCopy } from "@/lib/copy/campaigns";
import { homeCopy } from "@/lib/copy/home";

import { BriefBox } from "./BriefBox";
import { Card } from "./Card";
import { Chip } from "./Chip";
import { PageHeader } from "./PageHeader";

/**
 * Home once the rep has a campaign (master doc §23.1, product-truth pass): a
 * navigator, not a dashboard.
 *
 * Three blocks in one column. What needs the rep, with the one thing to do
 * on each; what Relay is doing right now, said as what it is doing and not
 * as progress; and the box to start another campaign. No analytics and no
 * counts beyond the number beside each heading, because a number Home cannot
 * stand behind is a number the rep stops trusting.
 *
 * The buckets are the stage summary's (`src/lib/campaigns/summary.ts`), so
 * this page, the Campaigns list and the campaign page agree on where a
 * campaign is. Done campaigns are not here: Home is about what is next, and
 * the list keeps the record.
 *
 * Pure: every value arrives as a prop, so the route can be a server component
 * that resolves the session and this can be rendered in a test without one.
 */

const ROW =
  "flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-line py-row-y first:border-t-0 transition-colors duration-micro ease-standard hover:bg-soft focus-visible:outline-none focus-visible:ring-2";

function Count({ n }: { n: number }) {
  return <span className="type-mono text-13 text-muted">{n}</span>;
}

/** What needs the rep, or is theirs to decide: the name, why, and the one thing to do. */
function NeedsYouRow({ campaign }: { campaign: CampaignSummary }) {
  return (
    <Link href={`/campaigns/${campaign.id}`} data-testid="home-needs-you-row" className={ROW}>
      <span className="min-w-0 flex-1">
        <span className="type-name block">{campaign.name}</span>
        <span className="type-small block text-muted sm:truncate">{campaign.summary.reason ?? campaign.summary.line}</span>
      </span>
      <span className="type-small text-action">{campaign.next}</span>
    </Link>
  );
}

/** What Relay is doing: the name, the line of what it has, and the word for where it is. */
function WorkingRow({ campaign }: { campaign: CampaignSummary }) {
  return (
    <Link href={`/campaigns/${campaign.id}`} data-testid="home-working-row" className={ROW}>
      <span className="min-w-0 flex-1">
        <span className="type-name block">{campaign.name}</span>
        <span className="type-small block text-muted sm:truncate">{campaign.summary.line ?? campaign.motionLine}</span>
      </span>
      {/* A queued job is waiting, and the chip says so: never "Researching" for a job nothing has picked up. */}
      {campaign.summary.waiting ? (
        <Chip>{campaignsCopy.summaryWaiting}</Chip>
      ) : (
        <Chip tone="ok">{campaign.summary.stage}</Chip>
      )}
    </Link>
  );
}

export function Home({
  firstName,
  today,
  connections,
  campaigns,
  startBrief,
}: {
  firstName: string;
  /** Already formatted by the server, so the markup does not depend on the reader's clock. */
  today: string;
  connections: { mailbox: boolean };
  campaigns: readonly CampaignSummary[];
  startBrief: (previous: string | null, form: FormData) => Promise<string | null>;
}) {
  // "Ready" sits with the decisions: emails are ready and outreach is the rep's next call.
  const needsYou = campaigns.filter((campaign) => ["needsYou", "decide", "ready"].includes(campaign.summary.bucket));
  const working = campaigns.filter((campaign) => campaign.summary.bucket === "working");

  return (
    <>
      <PageHeader title={`${homeCopy.welcome}, ${firstName}`} note={today} />

      {/* One column, centred. 880px is the widest a single list column reads well at; not a signed number. */}
      <div data-testid="home-blocks" className="mx-auto grid w-full min-w-0 max-w-[880px] grid-cols-[minmax(0,1fr)] gap-grid">
        <Card label={homeCopy.needsYouLabel} aside={<Count n={needsYou.length} />}>
          {needsYou.length === 0 ? (
            <p className="type-small text-muted">{homeCopy.needsYouEmpty}</p>
          ) : (
            needsYou.map((campaign) => <NeedsYouRow key={campaign.id} campaign={campaign} />)
          )}
        </Card>

        <Card label={homeCopy.workingLabel} aside={<Count n={working.length} />}>
          {working.length === 0 ? (
            <p className="type-small text-muted">{homeCopy.workingEmpty}</p>
          ) : (
            working.map((campaign) => <WorkingRow key={campaign.id} campaign={campaign} />)
          )}
        </Card>

        <Card label={homeCopy.startLabel} className="min-w-0">
          {connections.mailbox ? null : <p className="type-small mb-3 text-muted">{homeCopy.connectMailbox}</p>}

          <BriefBox
            label={homeCopy.briefQuestion}
            placeholder={homeCopy.briefPlaceholder}
            submitLabel={homeCopy.briefStart}
            action={startBrief}
          />

          <p className="type-small mt-3 text-12 text-muted">{homeCopy.briefFooter}</p>
        </Card>
      </div>
    </>
  );
}
