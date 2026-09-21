import { Calendar } from "@/components/calendar/Calendar";
import { knownCampaign, parseCalendarQuery } from "@/lib/outreach/calendar";
import { londonDay } from "@/lib/outreach/sequence";
import { serverCaller } from "@/server/api/caller";

/**
 * The outreach calendar (Relay P6): what is due this week across the rep's
 * campaigns. The week and the filters are in the URL; the server reads what
 * is open up to the week's Friday and the component puts it in columns.
 */
export const dynamic = "force-dynamic";

export default async function CalendarPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const today = londonDay(new Date());
  const query = parseCalendarQuery(await searchParams, today);
  const caller = await serverCaller();
  const view = await caller.tracking.calendarWeek({ week: query.week });
  return <Calendar today={today} query={{ week: view.week, filter: knownCampaign(query.filter, view.campaigns) }} items={view.items} campaigns={view.campaigns} pausedCampaigns={view.pausedCampaigns} />;
}
