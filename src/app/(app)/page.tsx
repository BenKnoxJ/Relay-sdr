import { Home } from "@/components/Home";
import { HomeDayOne } from "@/components/HomeDayOne";
import { dueToday } from "@/lib/outreach/calendar";
import { londonDay } from "@/lib/outreach/sequence";
import { dateLabel, firstNameFor } from "@/lib/shell";
import { me, serverCaller } from "@/server/api/caller";
import { listCampaigns } from "@/server/campaigns";

import { startBrief } from "./actions";

/**
 * Home (master doc §23.1, §23.1a). Day one is a single card with the brief
 * box, because there is no campaign to navigate to yet; from the first
 * campaign on it is the navigator: what needs the rep, what Relay is doing,
 * and the box to start another.
 *
 * The page resolves who is signed in, what they have connected and what they
 * have running, formats the date, and hands all of it to a component that
 * knows nothing about any of it. Next refuses a page module that exports
 * anything else, so the two helpers it needs live in `src/lib/shell.ts`
 * where a test can reach them.
 */
export default async function HomePage() {
  const [who, { campaigns }] = await Promise.all([me(), listCampaigns()]);
  const firstName = firstNameFor(who.name, who.email);
  const today = dateLabel(new Date());

  if (campaigns.length === 0) {
    return <HomeDayOne firstName={firstName} today={today} connections={who.connections} startBrief={startBrief} />;
  }

  // Today's outreach (Relay P6), from the calendar's own read; only once outreach is running somewhere.
  const day = londonDay(new Date());
  const week = await (await serverCaller()).tracking.calendarWeek({ week: day });
  const due = week.campaigns.length === 0 ? undefined : dueToday(week.items, day);

  return <Home firstName={firstName} today={today} connections={who.connections} campaigns={campaigns} startBrief={startBrief} {...(due === undefined ? {} : { dueToday: due })} />;
}
