import Link from "next/link";

import { bucketOf, chipToneOf, isWaiting, reasonLineOf, stageLineOf } from "@/lib/campaigns/stageLine";
import type { CampaignSummary } from "@/lib/campaigns/types";
import { CALENDAR_CHANNELS, type DueToday } from "@/lib/outreach/calendar";
import { calendarCopy } from "@/lib/copy/calendar";
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
 * Blocks in one column, in the same five words the Campaigns list groups
 * by (`bucketOf`): what needs the rep, with the one thing to do on each;
 * what is theirs to decide; what is ready; what Relay is doing right now,
 * said as what it is doing and not as progress; and the box to start
 * another campaign. A block with nothing in it is not drawn, except the
 * first: "nothing needs you" is worth saying. No analytics and no counts
 * beyond the number beside each heading, because a number Home cannot stand
 * behind is a number the rep stops trusting.
 *
 * Every row reads the backend's summary facts (`facts.stage`, `attention`,
 * `nextAction`, the counts) through `src/lib/campaigns/stageLine.ts`, so this
 * page, the Campaigns list and the campaign page agree on where a campaign
 * is. A campaign with no facts (a sample) is not drawn here.
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
function NeedsYouRow({ campaign, testId }: { campaign: WithFacts; testId: string }) {
  const line = reasonLineOf(campaign.facts) ?? stageLineOf(campaign.facts);
  return (
    <Link href={`/campaigns/${campaign.id}`} data-testid={testId} className={ROW}>
      <span className="min-w-0 flex-1">
        <span className="type-name block">{campaign.name}</span>
        {line === null ? null : <span className="type-small block text-muted sm:truncate">{line}</span>}
      </span>
      <span className="type-small text-action">{campaign.next}</span>
    </Link>
  );
}

/** What Relay is doing: the name, the line of what it has, and the word for where it is. */
function WorkingRow({ campaign }: { campaign: WithFacts }) {
  return (
    <Link href={`/campaigns/${campaign.id}`} data-testid="home-working-row" className={ROW}>
      <span className="min-w-0 flex-1">
        <span className="type-name block">{campaign.name}</span>
        <span className="type-small block text-muted sm:truncate">{stageLineOf(campaign.facts) ?? campaign.motionLine}</span>
      </span>
      {/* A queued job is waiting, and the chip says so: never "Researching" for a job nothing has picked up. */}
      <Chip tone={chipToneOf("working", isWaiting(campaign.facts))}>{isWaiting(campaign.facts) ? campaignsCopy.summaryWaiting : campaign.chip}</Chip>
    </Link>
  );
}

/** Today's outreach in one row (Relay P6): the calendar's own counts, and a link to it. */
function DueTodayRow({ due }: { due: DueToday }) {
  const c = calendarCopy;
  const parts = CALENDAR_CHANNELS.filter((channel) => due.counts[channel] > 0).map((channel) => `${due.counts[channel]} ${due.counts[channel] === 1 ? c.channelOne[channel] : c.channelMany[channel]}`);
  const today = parts.length === 0 ? c.nothingDueToday : `${c.dueTodayLabel}: ${parts.join(" · ")}`;
  return (
    <Link href="/calendar" data-testid="home-due-today" className={ROW}>
      <span className="type-name min-w-0 flex-1">
        {today}
        {due.overdue === 0 ? null : <span className="text-warn">{` · ${due.overdue} ${c.overdueCount}`}</span>}
      </span>
      <span className="type-small text-action">{c.openCalendar}</span>
    </Link>
  );
}

type WithFacts = CampaignSummary & { facts: NonNullable<CampaignSummary["facts"]> };
const withFacts = (campaign: CampaignSummary): campaign is WithFacts => campaign.facts !== undefined;

export function Home({
  firstName,
  today,
  connections,
  campaigns,
  dueToday,
  startBrief,
}: {
  firstName: string;
  /** Already formatted by the server, so the markup does not depend on the reader's clock. */
  today: string;
  connections: { mailbox: boolean };
  campaigns: readonly CampaignSummary[];
  /** What is due today, when the rep has outreach running; absent, the row is not drawn. */
  dueToday?: DueToday;
  startBrief: (previous: string | null, form: FormData) => Promise<string | null>;
}) {
  const stored = campaigns.filter(withFacts);
  const inBucket = (bucket: ReturnType<typeof bucketOf>) => stored.filter((campaign) => bucketOf(campaign.facts) === bucket);
  const needsYou = inBucket("needsYou");
  const decide = inBucket("decide");
  const ready = inBucket("ready");
  const working = inBucket("working");

  return (
    <>
      <PageHeader title={`${homeCopy.welcome}, ${firstName}`} note={today} />

      {/* One column, centred. 880px is the widest a single list column reads well at; not a signed number. */}
      <div data-testid="home-blocks" className="mx-auto grid w-full min-w-0 max-w-[880px] grid-cols-[minmax(0,1fr)] gap-grid">
        {dueToday === undefined ? null : (
          <Card>
            <DueTodayRow due={dueToday} />
          </Card>
        )}

        <Card label={homeCopy.needsYouLabel} aside={<Count n={needsYou.length} />}>
          {needsYou.length === 0 ? (
            <p className="type-small text-muted">{homeCopy.needsYouEmpty}</p>
          ) : (
            needsYou.map((campaign) => <NeedsYouRow key={campaign.id} campaign={campaign} testId="home-needs-you-row" />)
          )}
        </Card>

        {decide.length === 0 ? null : (
          <Card label={homeCopy.decideLabel} aside={<Count n={decide.length} />}>
            {decide.map((campaign) => (
              <NeedsYouRow key={campaign.id} campaign={campaign} testId="home-decide-row" />
            ))}
          </Card>
        )}

        {ready.length === 0 ? null : (
          <Card label={homeCopy.readyLabel} aside={<Count n={ready.length} />}>
            {ready.map((campaign) => (
              <NeedsYouRow key={campaign.id} campaign={campaign} testId="home-ready-row" />
            ))}
          </Card>
        )}

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
