import { describe, expect, it } from "vitest";

import { SEQUENCE } from "../../agents/outreach/input.schema";
import { SEQUENCE_TEMPLATE, addWorkingDays, fromDbDate, londonDay, nextWorkingDay, stepDueDates, stepStates, toDbDate } from "@/lib/outreach/sequence";

/**
 * P3 (21 Sep 2026): a person's sequence dates are pure date maths on
 * calendar days in Europe/London, counted in working days (Mon–Fri) from
 * their own start day. No clock, no scheduler: `today` is an argument.
 */

describe("addWorkingDays", () => {
  it("skips the weekend: Friday + 1 is Monday", () => {
    expect(addWorkingDays("2026-09-25", 1)).toBe("2026-09-28");
  });

  it("snaps a weekend start to the Monday before counting: 0 from Saturday is Monday", () => {
    expect(addWorkingDays("2026-09-26", 0)).toBe("2026-09-28");
    expect(addWorkingDays("2026-09-27", 0)).toBe("2026-09-28");
    expect(addWorkingDays("2026-09-26", 1)).toBe("2026-09-29");
  });

  it("counts across several weekends and a month end", () => {
    expect(addWorkingDays("2026-09-21", 0)).toBe("2026-09-21");
    expect(addWorkingDays("2026-09-21", 5)).toBe("2026-09-28");
    expect(addWorkingDays("2026-09-24", 12)).toBe("2026-10-12");
  });

  it("refuses what is not a calendar day or a whole, non-negative count", () => {
    expect(() => addWorkingDays("2026-02-30", 1)).toThrow();
    expect(() => addWorkingDays("2026-09-21T09:00:00Z", 1)).toThrow();
    expect(() => addWorkingDays("2026-09-21", -1)).toThrow();
    expect(() => addWorkingDays("2026-09-21", 1.5)).toThrow();
  });
});

describe("the template", () => {
  it("is the D1 timing, and every step names a touch the sequence drafts", () => {
    expect(SEQUENCE_TEMPLATE.map((step) => [step.id, step.touch, "offset" in step ? step.offset : step.after])).toEqual([
      ["email1", "email1", 0],
      ["li_connect", "li_connect", 1],
      ["call1", "call", 3],
      ["email2", "email2", 5],
      ["li_dm", "li_dm", "accepted"],
      ["call2", "call", 8],
      ["li_dm2", "li_dm2", "li_dm_sent"],
      ["breakup", "breakup", 12],
    ]);
    for (const step of SEQUENCE_TEMPLATE) expect(SEQUENCE).toContain(step.touch);
  });
});

const dues = (start: string, events: Parameters<typeof stepDueDates>[1] = {}) => Object.fromEntries(stepDueDates(start, events).map((step) => [step.id, step.due]));

describe("stepDueDates", () => {
  it("dates a Monday start", () => {
    expect(dues("2026-09-21")).toEqual({
      email1: "2026-09-21",
      li_connect: "2026-09-22",
      call1: "2026-09-24",
      email2: "2026-09-28",
      li_dm: null,
      call2: "2026-10-01",
      li_dm2: null,
      breakup: "2026-10-07",
    });
  });

  it("dates a Thursday start across the weekends", () => {
    expect(dues("2026-09-24")).toEqual({
      email1: "2026-09-24",
      li_connect: "2026-09-25",
      call1: "2026-09-29",
      email2: "2026-10-01",
      li_dm: null,
      call2: "2026-10-06",
      li_dm2: null,
      breakup: "2026-10-12",
    });
  });

  it("leaves the LinkedIn message waiting until the connect is accepted", () => {
    const step = stepDueDates("2026-09-21").find((s) => s.id === "li_dm");
    expect(step).toMatchObject({ due: null, waitingFor: "accepted" });
  });

  it("dates the LinkedIn message on the later of day 5 and the accept", () => {
    // Accepted early: not before day 5.
    expect(dues("2026-09-21", { acceptedOn: "2026-09-22" }).li_dm).toBe("2026-09-28");
    // Accepted late: the accept day.
    expect(dues("2026-09-21", { acceptedOn: "2026-10-02" }).li_dm).toBe("2026-10-02");
    // Accepted on a Saturday: the Monday after.
    expect(dues("2026-09-21", { acceptedOn: "2026-10-03" }).li_dm).toBe("2026-10-05");
  });

  it("dates the follow-up 4 working days after the message was sent, and waits until then", () => {
    expect(stepDueDates("2026-09-21", { acceptedOn: "2026-09-22" }).find((s) => s.id === "li_dm2")).toMatchObject({ due: null, waitingFor: "li_dm_sent" });
    expect(dues("2026-09-21", { acceptedOn: "2026-09-22", liDmSentOn: "2026-09-28" }).li_dm2).toBe("2026-10-02");
    expect(dues("2026-09-21", { acceptedOn: "2026-09-22", liDmSentOn: "2026-10-01" }).li_dm2).toBe("2026-10-07");
  });
});

const states = (today: string, paused = false) => Object.fromEntries(stepStates(stepDueDates("2026-09-21"), { today, paused }).map((step) => [step.id, step.state]));

describe("stepStates", () => {
  it("is due on the day, overdue after it, and planned before it", () => {
    expect(states("2026-09-22")).toEqual({
      email1: "overdue",
      li_connect: "due",
      call1: "planned",
      email2: "planned",
      li_dm: "waiting",
      call2: "planned",
      li_dm2: "waiting",
      breakup: "planned",
    });
  });

  it("before the start day, everything dated is planned", () => {
    expect(states("2026-09-18")).toMatchObject({ email1: "planned", li_connect: "planned", breakup: "planned" });
  });

  it("while the campaign is paused, every step is paused and nothing is due", () => {
    const paused = states("2026-09-22", true);
    expect(new Set(Object.values(paused))).toEqual(new Set(["paused"]));
  });
});

describe("the rep's day is London's", () => {
  it("a late-evening UTC time in summer is already tomorrow in London", () => {
    // 23:30 UTC on 30 Sep is 00:30 BST on 1 Oct.
    expect(londonDay(new Date("2026-09-30T23:30:00Z"))).toBe("2026-10-01");
  });

  it("a late-evening UTC time in winter is still the same day in London", () => {
    // GMT: London and UTC agree.
    expect(londonDay(new Date("2026-12-01T23:30:00Z"))).toBe("2026-12-01");
  });

  it("an early-morning UTC time does not move to yesterday", () => {
    expect(londonDay(new Date("2026-09-22T00:15:00Z"))).toBe("2026-09-22");
  });

  it("the next working day follows London's today, over a weekend", () => {
    // Friday 23:30 UTC in September is already Saturday in London: next working day is Monday.
    expect(nextWorkingDay(new Date("2026-09-25T23:30:00Z"))).toBe("2026-09-28");
    // Friday afternoon: Monday.
    expect(nextWorkingDay(new Date("2026-09-25T15:00:00Z"))).toBe("2026-09-28");
    // Monday: Tuesday.
    expect(nextWorkingDay(new Date("2026-09-21T09:00:00Z"))).toBe("2026-09-22");
  });

  it("a stored date round-trips as the same calendar day, whatever the server's zone", () => {
    const stored = toDbDate("2026-09-28");
    expect(stored.toISOString()).toBe("2026-09-28T00:00:00.000Z");
    expect(fromDbDate(stored)).toBe("2026-09-28");
  });
});
