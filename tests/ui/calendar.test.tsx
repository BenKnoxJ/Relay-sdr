import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { Calendar } from "@/components/calendar/Calendar";
import { Home } from "@/components/Home";
import { calendarCopy as c } from "@/lib/copy/calendar";
import { outreachPeopleCopy } from "@/lib/copy/outreachPeople";
import { EMAIL_DAY_CAP, type CalendarItem, type CalendarQuery } from "@/lib/outreach/calendar";
import { stepState, type StepId } from "@/lib/outreach/sequence";

/**
 * The calendar screen (Relay P6): Overdue and the five days as headed
 * sections, each item a link to the person's drawer, the day's counts, the
 * week in the URL, the filters, the paused line and the empty week. And
 * Home's one row about today.
 */

const replace = vi.fn();
vi.mock("next/navigation", () => ({ usePathname: () => "/calendar", useRouter: () => ({ push: vi.fn(), replace, refresh: vi.fn() }) }));
beforeEach(() => replace.mockReset());

const TODAY = "2026-09-30"; // a Wednesday; the week runs into October
const WEEK = "2026-09-28";
const ALL: CalendarQuery = { week: WEEK, filter: { campaign: null, channel: null } };
const CAMPAIGNS = [
  { id: "c1", name: "Logistics" },
  { id: "c2", name: "Care homes" },
];

let serial = 0;
function item(step: StepId, due: string, over: Partial<CalendarItem> = {}): CalendarItem {
  serial += 1;
  return { campaignId: "c1", campaignName: "Logistics", campaignPersonId: `cp${serial}`, name: `Person ${serial}`, company: `Firm ${serial}`, step, due, state: stepState(due, { today: TODAY, paused: false }), needsApproval: false, ...over };
}

function draw(items: CalendarItem[], extra: Partial<Parameters<typeof Calendar>[0]> = {}) {
  return render(<Calendar today={TODAY} query={ALL} items={items} campaigns={CAMPAIGNS} pausedCampaigns={0} {...extra} />);
}

describe("Calendar", () => {
  it("draws Overdue then Monday to Friday, each a section with a heading, and marks today", () => {
    draw([item("email1", "2026-09-24"), item("call1", TODAY)]);
    const headings = screen.getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent);
    expect(headings).toEqual([c.overdue, "Mon 28 Sep", "Tue 29 Sep", `Wed 30 Sep, ${c.today}`, "Thu 1 Oct", "Fri 2 Oct"]);
    expect(screen.getByRole("region", { name: `Wed 30 Sep, ${c.today}` }).getAttribute("data-today")).toBe("true");
    expect(within(screen.getByRole("region", { name: c.overdue })).getAllByTestId("calendar-item")).toHaveLength(1);
  });

  it("makes each card a link to the person's drawer on their campaign's People tab", () => {
    draw([item("email2", TODAY, { campaignId: "c2", campaignPersonId: "cp-x", campaignName: "Care homes", name: "Avery Dunmore", company: "Dunmore Ltd", needsApproval: true })]);
    const card = screen.getByRole("link", { name: /Avery Dunmore/ });
    expect(card.getAttribute("href")).toBe("/campaigns/c2?tab=people&person=cp-x");
    expect(card.textContent).toContain(outreachPeopleCopy.step.email2);
    expect(card.textContent).toContain("Dunmore Ltd · Care homes");
    expect(within(card).getByText(c.needsApproval)).toBeTruthy();
  });

  it("heads a day with its counts by channel, the emails needing approval, and the cap flag", () => {
    const emails = Array.from({ length: EMAIL_DAY_CAP + 1 }, () => item("email1", "2026-10-01", { needsApproval: true }));
    draw([...emails, item("li_connect", "2026-10-01"), item("call1", "2026-10-01"), item("call2", "2026-10-01")]);
    const thursday = screen.getByRole("region", { name: "Thu 1 Oct" });
    const counts = within(thursday).getByTestId("calendar-day-counts");
    expect(within(counts).getByText(`${EMAIL_DAY_CAP + 1} ${c.channelMany.email}`)).toBeTruthy();
    expect(within(counts).getByText(`1 ${c.channelOne.linkedin}`)).toBeTruthy();
    expect(within(counts).getByText(`2 ${c.channelMany.call}`)).toBeTruthy();
    expect(within(thursday).getByTestId("calendar-need-approval").textContent).toBe(`${EMAIL_DAY_CAP + 1} ${c.needApproval}`);
    expect(within(thursday).getByTestId("calendar-over-cap").textContent).toBe(`${c.overCap} ${EMAIL_DAY_CAP}`);
    expect(screen.getAllByTestId("calendar-over-cap")).toHaveLength(1);
  });

  it("keeps the week in the URL: previous and next cross the month boundary and keep the filters", () => {
    draw([item("call1", TODAY)], { query: { week: WEEK, filter: { campaign: "c2", channel: "call" } } });
    expect(screen.getByTestId("calendar-prev").getAttribute("href")).toBe("/calendar?week=2026-09-21&campaign=c2&channel=call");
    expect(screen.getByTestId("calendar-next").getAttribute("href")).toBe("/calendar?week=2026-10-05&campaign=c2&channel=call");
    expect(screen.getByTestId("calendar-this-week").getAttribute("aria-current")).toBe("page");
  });

  it("filters by campaign and channel through the URL", () => {
    draw([item("call1", TODAY)]);
    fireEvent.change(screen.getByLabelText(c.filterCampaign), { target: { value: "c2" } });
    expect(replace).toHaveBeenLastCalledWith(`/calendar?week=${WEEK}&campaign=c2`, { scroll: false });
    fireEvent.change(screen.getByLabelText(c.filterChannel), { target: { value: "linkedin" } });
    expect(replace).toHaveBeenLastCalledWith(`/calendar?week=${WEEK}&channel=linkedin`, { scroll: false });
  });

  it("shows only what the filters let through", () => {
    draw([item("call1", TODAY), item("email1", TODAY, { campaignId: "c2" })], { query: { week: WEEK, filter: { campaign: "c2", channel: null } } });
    expect(screen.getAllByTestId("calendar-item").map((card) => card.getAttribute("data-channel"))).toEqual(["email"]);
  });

  it("says a week with nothing due is empty even while Overdue still has something", () => {
    draw([item("call1", "2026-09-24")], { query: { ...ALL, week: "2026-10-12" } });
    expect(screen.getByTestId("calendar-empty").textContent).toBe(c.empty);
    expect(within(screen.getByRole("region", { name: c.overdue })).getAllByTestId("calendar-item")).toHaveLength(1);
  });

  it("says one email needs approval, in the singular", () => {
    draw([item("email1", TODAY, { needsApproval: true })]);
    expect(screen.getByTestId("calendar-need-approval").textContent).toBe(`1 ${c.needApprovalOne}`);
  });

  it("says a week with nothing due is empty, and says how many campaigns are paused", () => {
    draw([], { pausedCampaigns: 2 });
    expect(screen.getByTestId("calendar-empty").textContent).toBe(c.empty);
    expect(screen.queryByTestId("calendar-grid")).toBeNull();
    expect(screen.getByTestId("calendar-paused").textContent).toBe(`2 ${c.campaignsPaused}`);
  });
});

describe("Home's row", () => {
  const noop = async () => null;
  it("says what is due today by channel and links to the calendar", () => {
    render(<Home firstName="Ben" today="Wed 30 Sep" connections={{ mailbox: true }} campaigns={[]} startBrief={noop} dueToday={{ counts: { email: 4, linkedin: 3, call: 1 }, overdue: 2, total: 10 }} />);
    const row = screen.getByTestId("home-due-today");
    expect(row.getAttribute("href")).toBe("/calendar");
    expect(row.textContent).toContain(`${c.dueTodayLabel}: 4 ${c.channelMany.email} · 3 ${c.channelMany.linkedin} · 1 ${c.channelOne.call}`);
    expect(row.textContent).toContain(`2 ${c.overdueCount}`);
  });

  it("is not drawn without outreach running", () => {
    render(<Home firstName="Ben" today="Wed 30 Sep" connections={{ mailbox: true }} campaigns={[]} startBrief={noop} />);
    expect(screen.queryByTestId("home-due-today")).toBeNull();
  });
});
