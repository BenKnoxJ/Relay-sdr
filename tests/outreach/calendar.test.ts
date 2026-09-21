import { describe, expect, it } from "vitest";

import {
  EMAIL_DAY_CAP,
  buildWeek,
  calendarHref,
  dueToday,
  knownCampaign,
  parseCalendarQuery,
  shiftWeek,
  weekDays,
  weekStartOf,
  type CalendarItem,
} from "@/lib/outreach/calendar";
import { stepDueDates, stepState, type StepId } from "@/lib/outreach/sequence";

/**
 * The calendar's pure half (Relay P6): the week maths, the URL, and putting
 * P4's folded items into Overdue and Monday to Friday. Due days and states
 * here come from P3's own functions, never written by hand where it matters.
 */

const TODAY = "2026-09-23"; // a Wednesday
const WEEK = "2026-09-21";
const ALL = { campaign: null, channel: null } as const;

let serial = 0;
function item(step: StepId, due: string, over: Partial<CalendarItem> = {}, today: string = TODAY): CalendarItem {
  serial += 1;
  return {
    campaignId: "c1",
    campaignName: "Logistics",
    campaignPersonId: `p${serial}`,
    name: `Person ${serial}`,
    company: `Firm ${serial}`,
    step,
    due,
    state: stepState(due, { today, paused: false }),
    needsApproval: false,
    ...over,
  };
}

describe("the week", () => {
  it("starts on the Monday; a weekend reads as the week after", () => {
    expect(weekStartOf("2026-09-21")).toBe("2026-09-21");
    expect(weekStartOf("2026-09-25")).toBe("2026-09-21");
    expect(weekStartOf("2026-09-26")).toBe("2026-09-28");
    expect(weekStartOf("2026-09-27")).toBe("2026-09-28");
    expect(weekDays(WEEK)).toEqual(["2026-09-21", "2026-09-22", "2026-09-23", "2026-09-24", "2026-09-25"]);
  });

  it("moves a week at a time across a month boundary and a year boundary", () => {
    expect(shiftWeek("2026-09-28", 1)).toBe("2026-10-05");
    expect(weekDays("2026-09-28")).toEqual(["2026-09-28", "2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02"]);
    expect(shiftWeek("2026-10-05", -1)).toBe("2026-09-28");
    expect(shiftWeek("2026-12-28", 1)).toBe("2027-01-04");
  });
});

describe("the URL", () => {
  it("reads the week and the filters, and writes them back", () => {
    const query = parseCalendarQuery({ week: "2026-10-01", campaign: "c2", channel: "call" }, TODAY);
    expect(query).toEqual({ week: "2026-09-28", filter: { campaign: "c2", channel: "call" } });
    expect(calendarHref(query)).toBe("/calendar?week=2026-09-28&campaign=c2&channel=call");
    expect(parseCalendarQuery(parseParams(calendarHref(query)), TODAY)).toEqual(query);
  });

  it("reads a missing or broken week as this one, and an unknown channel as all", () => {
    expect(parseCalendarQuery({}, TODAY)).toEqual({ week: WEEK, filter: ALL });
    expect(parseCalendarQuery({ week: "2026-02-30", channel: "fax" }, TODAY)).toEqual({ week: WEEK, filter: ALL });
    expect(parseCalendarQuery({ week: ["2026-10-05", "x"] }, TODAY).week).toBe("2026-10-05");
  });
});

describe("a campaign filter that is not a running campaign", () => {
  it("is dropped, so the page shows everything and the filter can be changed", () => {
    const campaigns = [{ id: "c1" }];
    expect(knownCampaign({ campaign: "c1", channel: "call" }, campaigns)).toEqual({ campaign: "c1", channel: "call" });
    expect(knownCampaign({ campaign: "gone", channel: "call" }, campaigns)).toEqual({ campaign: null, channel: "call" });
    expect(knownCampaign({ campaign: null, channel: null }, [])).toEqual({ campaign: null, channel: null });
  });
});

function parseParams(href: string): Record<string, string> {
  return Object.fromEntries(new URL(href, "http://x").searchParams.entries());
}

describe("grouping", () => {
  it("puts overdue items in Overdue and the rest on their weekday; today is marked", () => {
    const items = [item("email1", "2026-09-18"), item("call1", "2026-09-22"), item("email2", TODAY), item("li_connect", "2026-09-25"), item("breakup", "2026-10-01")];
    const week = buildWeek(items, { today: TODAY, week: WEEK, filter: ALL });
    expect(week.overdue.map((i) => i.due)).toEqual(["2026-09-18", "2026-09-22"]);
    expect(week.days.map((day) => day.items.map((i) => i.step))).toEqual([[], [], ["email2"], [], ["li_connect"]]);
    expect(week.days.map((day) => day.isToday)).toEqual([false, false, true, false, false]);
    expect(week.empty).toBe(false);
  });

  it("shows Overdue on any week, and nothing on a week with nothing due", () => {
    const items = [item("email1", "2026-09-18")];
    const next = buildWeek(items, { today: TODAY, week: "2026-09-28", filter: ALL });
    expect(next.overdue).toHaveLength(1);
    expect(buildWeek([], { today: TODAY, week: WEEK, filter: ALL }).empty).toBe(true);
  });

  it("puts two batches with different start days on their own days (P3's dates)", () => {
    const batchA = stepDueDates("2026-09-14").filter((step) => step.due !== null);
    const batchB = stepDueDates("2026-09-21").filter((step) => step.due !== null);
    const items = [
      ...batchA.map((step) => item(step.id, step.due!, { campaignPersonId: "a", name: "Batch A" }, "2026-09-21")),
      ...batchB.map((step) => item(step.id, step.due!, { campaignPersonId: "b", name: "Batch B" }, "2026-09-21")),
    ];
    const week = buildWeek(items, { today: "2026-09-21", week: WEEK, filter: ALL });
    const onDay = (n: number) => week.days[n]!.items.map((i) => `${i.name}:${i.step}`);
    // A started 14 Sep: Email 2 is day 5 (Mon 21), Call 2 day 8 (Thu 24). B started 21 Sep: Email 1 Mon, connect Tue, Call 1 Thu.
    expect(onDay(0)).toEqual(["Batch A:email2", "Batch B:email1"]);
    expect(onDay(1)).toEqual(["Batch B:li_connect"]);
    expect(onDay(3)).toEqual(["Batch A:call2", "Batch B:call1"]);
    expect(week.overdue.map((i) => `${i.name}:${i.step}`)).toEqual(["Batch A:email1", "Batch A:li_connect", "Batch A:call1"]);
  });
});

describe("a day's header", () => {
  it("counts by channel, the connect note and messages as LinkedIn", () => {
    const items = [item("email1", TODAY), item("email2", TODAY), item("li_connect", TODAY), item("li_dm", TODAY), item("call1", TODAY)];
    expect(buildWeek(items, { today: TODAY, week: WEEK, filter: ALL }).days[2]!.counts).toEqual({ email: 2, linkedin: 2, call: 1 });
  });

  it("counts the emails that need approval", () => {
    const items = [item("email1", TODAY, { needsApproval: true }), item("email2", TODAY, { needsApproval: true }), item("breakup", TODAY)];
    expect(buildWeek(items, { today: TODAY, week: WEEK, filter: ALL }).days[2]!.needApproval).toBe(2);
  });

  it("flags a day with more emails due than the cap, whatever the filters", () => {
    const at = (n: number) => Array.from({ length: n }, (_, i) => item("email1", "2026-09-24", { campaignId: i % 2 === 0 ? "c1" : "c2" }));
    expect(buildWeek(at(EMAIL_DAY_CAP), { today: TODAY, week: WEEK, filter: ALL }).days[3]!.overCap).toBe(false);
    const over = at(EMAIL_DAY_CAP + 1);
    expect(buildWeek(over, { today: TODAY, week: WEEK, filter: ALL }).days[3]!.overCap).toBe(true);
    expect(buildWeek(over, { today: TODAY, week: WEEK, filter: { campaign: "c1", channel: "call" } }).days[3]).toMatchObject({ overCap: true, items: [] });
  });
});

describe("filters", () => {
  it("shows one campaign, or one channel, and counts only what is shown", () => {
    const items = [item("email1", TODAY), item("call1", TODAY, { campaignId: "c2" }), item("li_dm", TODAY, { campaignId: "c2" }), item("email1", "2026-09-18", { campaignId: "c2" })];
    const c2 = buildWeek(items, { today: TODAY, week: WEEK, filter: { campaign: "c2", channel: null } });
    expect(c2.days[2]!.counts).toEqual({ email: 0, linkedin: 1, call: 1 });
    expect(c2.overdue).toHaveLength(1);
    const calls = buildWeek(items, { today: TODAY, week: WEEK, filter: { campaign: null, channel: "call" } });
    expect(calls.days[2]!.items.map((i) => i.step)).toEqual(["call1"]);
    expect(calls.overdue).toEqual([]);
    const linkedin = buildWeek(items, { today: TODAY, week: WEEK, filter: { campaign: null, channel: "linkedin" } });
    expect(linkedin.days[2]!.items.map((i) => i.step)).toEqual(["li_dm"]);
  });
});

describe("Home's line", () => {
  it("counts today's items by channel, and the overdue ones apart", () => {
    const items = [item("email1", TODAY), item("li_connect", TODAY), item("call1", TODAY), item("call2", TODAY), item("email2", "2026-09-18"), item("breakup", "2026-09-24")];
    expect(dueToday(items, TODAY)).toEqual({ counts: { email: 1, linkedin: 1, call: 2 }, overdue: 1, total: 5 });
  });
});
