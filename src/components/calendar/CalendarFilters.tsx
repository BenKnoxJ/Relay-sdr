"use client";

import { useRouter } from "next/navigation";
import { useId } from "react";

import { calendarCopy as c } from "@/lib/copy/calendar";
import { CALENDAR_CHANNELS, calendarHref, type CalendarChannel, type CalendarQuery } from "@/lib/outreach/calendar";

/** The calendar's two filters, campaign and channel. A change is a new URL, so a view can be linked. */
export function CalendarFilters({ query, campaigns }: { query: CalendarQuery; campaigns: ReadonlyArray<{ id: string; name: string }> }) {
  const router = useRouter();
  const campaignId = useId();
  const channelId = useId();
  const go = (filter: CalendarQuery["filter"]) => router.replace(calendarHref({ ...query, filter }), { scroll: false });
  const select = "type-body rounded-input border-control border-line bg-ground px-2 py-1.5 text-ink outline-none focus-visible:ring-2";

  return (
    <div role="group" aria-label={c.filtersLabel} data-testid="calendar-filters" className="flex flex-wrap items-end gap-3">
      <div className="flex min-w-0 flex-col gap-1">
        <label htmlFor={campaignId} className="type-label">
          {c.filterCampaign}
        </label>
        <select
          id={campaignId}
          data-testid="calendar-filter-campaign"
          value={query.filter.campaign ?? ""}
          onChange={(event) => go({ ...query.filter, campaign: event.currentTarget.value === "" ? null : event.currentTarget.value })}
          className={`${select} max-w-full`}
        >
          <option value="">{c.filterCampaignAll}</option>
          {campaigns.map((campaign) => (
            <option key={campaign.id} value={campaign.id}>
              {campaign.name}
            </option>
          ))}
        </select>
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor={channelId} className="type-label">
          {c.filterChannel}
        </label>
        <select
          id={channelId}
          data-testid="calendar-filter-channel"
          value={query.filter.channel ?? ""}
          onChange={(event) => go({ ...query.filter, channel: event.currentTarget.value === "" ? null : (event.currentTarget.value as CalendarChannel) })}
          className={select}
        >
          <option value="">{c.filterChannelAll}</option>
          {CALENDAR_CHANNELS.map((channel) => (
            <option key={channel} value={channel}>
              {c.channelFilter[channel]}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}
