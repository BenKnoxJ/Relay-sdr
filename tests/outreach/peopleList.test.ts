import { describe, expect, it } from "vitest";

import {
  activityInDateOrder,
  copyTextOf,
  dueTone,
  filterPeople,
  isDueNow,
  markButtonsFor,
  parsePeopleFilter,
  peopleHref,
  sortByUrgency,
  undoableId,
  linkedinUrlOf,
  type ListRow,
} from "@/lib/outreach/peopleList";
import type { PersonStatus } from "@/lib/outreach/track";

/**
 * The People list and the drawer's pure rules (Relay P5): the order, the
 * filters and their URL, the due colours, which mark buttons a step shows,
 * what Copy copies, and which activity row Undo offers.
 */

// Mon 21 Sep 2026.
const TODAY = "2026-09-21";

const row = (name: string, due: string | null, status: PersonStatus = "in_sequence", company = "Firm"): ListRow & { tag: string } => ({
  campaignPersonId: `id-${name}`,
  name,
  company,
  status,
  nextDue: due === null ? null : { due },
  tag: name,
});

describe("the list's order", () => {
  it("is most urgent first: overdue (oldest first), then due today, then by next due day, then nothing due", () => {
    const rows = [row("Nothing", null), row("Friday", "2026-09-25"), row("Today", "2026-09-21"), row("LastWeek", "2026-09-14"), row("Friday2", "2026-09-18"), row("Tomorrow", "2026-09-22")];
    expect(sortByUrgency(rows).map((r) => r.tag)).toEqual(["LastWeek", "Friday2", "Today", "Tomorrow", "Friday", "Nothing"]);
  });

  it("breaks a tie by name, so the order is the same every time", () => {
    expect(sortByUrgency([row("Blair", TODAY), row("Avery", TODAY)]).map((r) => r.tag)).toEqual(["Avery", "Blair"]);
  });
});

describe("the filters", () => {
  const rows = [row("Avery Dunmore", "2026-09-18", "in_sequence", "Ardent Motor"), row("Blair Kendrick", "2026-09-23", "in_sequence", "Bramble"), row("Nell Oakley", null, "replied", "Oakley Insurance"), row("Orla Bellamy", TODAY, "meeting", "Bellamy & Co")];

  it("by status", () => {
    expect(filterPeople(rows, { status: "replied", due: false, q: "" }, TODAY).map((r) => r.tag)).toEqual(["Nell Oakley"]);
  });

  it("due today or overdue", () => {
    expect(filterPeople(rows, { status: null, due: true, q: "" }, TODAY).map((r) => r.tag)).toEqual(["Avery Dunmore", "Orla Bellamy"]);
    expect(isDueNow(rows[1]!, TODAY)).toBe(false);
  });

  it("a search by name or company, whatever the case", () => {
    expect(filterPeople(rows, { status: null, due: false, q: "bramble" }, TODAY).map((r) => r.tag)).toEqual(["Blair Kendrick"]);
    expect(filterPeople(rows, { status: null, due: false, q: "ORLA" }, TODAY).map((r) => r.tag)).toEqual(["Orla Bellamy"]);
  });

  it("all three together", () => {
    expect(filterPeople(rows, { status: "in_sequence", due: true, q: "ardent" }, TODAY).map((r) => r.tag)).toEqual(["Avery Dunmore"]);
  });

  it("read from the URL, and anything unknown is no filter", () => {
    expect(parsePeopleFilter({ tab: "people", status: "replied", due: "1", q: "  bram " })).toEqual({ status: "replied", due: true, q: "bram" });
    expect(parsePeopleFilter({ status: "everyone", due: "yes" })).toEqual({ status: null, due: false, q: "" });
    expect(parsePeopleFilter({ status: ["meeting", "closed"] })).toEqual({ status: "meeting", due: false, q: "" });
  });

  it("written back to the URL, with the person open in the drawer", () => {
    expect(peopleHref("c1", { status: null, due: false, q: "" })).toBe("/campaigns/c1?tab=people");
    expect(peopleHref("c1", { status: "replied", due: true, q: "a&b" }, "p9")).toBe("/campaigns/c1?tab=people&status=replied&due=1&q=a%26b&person=p9");
    expect(parsePeopleFilter(Object.fromEntries(new URL(`https://x${peopleHref("c1", { status: "closed", due: true, q: "a&b" })}`).searchParams))).toEqual({ status: "closed", due: true, q: "a&b" });
  });
});

describe("the due colours", () => {
  it("overdue before today; soon for today and the next two working days; otherwise none", () => {
    expect(dueTone("2026-09-18", TODAY)).toBe("overdue");
    expect(dueTone(TODAY, TODAY)).toBe("soon");
    expect(dueTone("2026-09-23", TODAY)).toBe("soon");
    expect(dueTone("2026-09-24", TODAY)).toBeNull();
    expect(dueTone(null, TODAY)).toBeNull();
  });

  it("counts working days: on a Friday, Tuesday is still soon and Wednesday is not", () => {
    expect(dueTone("2026-09-29", "2026-09-25")).toBe("soon");
    expect(dueTone("2026-09-30", "2026-09-25")).toBeNull();
  });
});

describe("the mark buttons on a step", () => {
  it("are the fold's valid next actions", () => {
    expect(markButtonsFor({ id: "li_connect", nextActions: ["sent"] }, null)).toEqual(["sent"]);
    expect(markButtonsFor({ id: "li_connect", nextActions: ["accepted", "declined"] }, "to_review")).toEqual(["accepted", "declined"]);
    expect(markButtonsFor({ id: "li_dm", nextActions: ["replied"] }, "to_review")).toEqual(["replied"]);
    expect(markButtonsFor({ id: "call1", nextActions: ["done"] }, "to_review")).toEqual(["done"]);
    expect(markButtonsFor({ id: "call2", nextActions: [] }, "to_review")).toEqual([]);
  });

  it("hold an email's Mark sent until it is approved; a reply or bounce is always there once sent", () => {
    expect(markButtonsFor({ id: "email1", nextActions: ["sent"] }, "to_review")).toEqual([]);
    expect(markButtonsFor({ id: "email1", nextActions: ["sent"] }, "needs_you")).toEqual([]);
    expect(markButtonsFor({ id: "email2", nextActions: ["sent"] }, null)).toEqual([]);
    expect(markButtonsFor({ id: "breakup", nextActions: ["sent"] }, "approved")).toEqual(["sent"]);
    expect(markButtonsFor({ id: "email1", nextActions: ["replied", "bounced"] }, "approved")).toEqual(["replied", "bounced"]);
  });
});

describe("Copy", () => {
  it("gives exactly the draft's text, never a subject line", () => {
    const draft = { subject: "connecting", body: "Delay conversations stood out. Worth connecting?" };
    expect(copyTextOf(draft)).toBe("Delay conversations stood out. Worth connecting?");
    expect(copyTextOf(draft)).not.toContain("connecting\n");
    expect(copyTextOf(draft).startsWith("Subject")).toBe(false);
    expect(copyTextOf({ body: "Open with: Hi.\n\nAsk: Worth a call?\n" })).toBe("Open with: Hi.\n\nAsk: Worth a call?");
    expect(copyTextOf({ body: null })).toBe("");
    expect(copyTextOf(null)).toBe("");
  });
});

describe("activity and Undo", () => {
  const events = [
    { id: "e1", kind: "sent", happenedOn: "2026-09-21", undone: false },
    { id: "e2", kind: "note", happenedOn: "2026-09-22", undone: true },
    { id: "e3", kind: "undo", happenedOn: "2026-09-22", undone: false },
    { id: "e4", kind: "done", happenedOn: "2026-09-18", undone: false },
    { id: "e5", kind: "accepted", happenedOn: "2026-09-22", undone: false },
  ];

  it("lists the rows that stand in date order, write order within a day", () => {
    expect(activityInDateOrder(events).map((event) => event.id)).toEqual(["e4", "e1", "e5"]);
  });

  it("offers Undo on the latest row written that still stands", () => {
    expect(undoableId(events)).toBe("e5");
    expect(undoableId([...events.slice(0, 4), { ...events[4]!, undone: true }])).toBe("e4");
    expect(undoableId([])).toBeNull();
  });
});

describe("a LinkedIn link", () => {
  it("is kept only when it is a web address", () => {
    expect(linkedinUrlOf("https://www.linkedin.com/in/avery")).toBe("https://www.linkedin.com/in/avery");
    expect(linkedinUrlOf(" http://linkedin.com/in/avery ")).toBe("http://linkedin.com/in/avery");
    expect(linkedinUrlOf("javascript:alert(1)")).toBeNull();
    expect(linkedinUrlOf("linkedin.com/in/avery")).toBeNull();
    expect(linkedinUrlOf("")).toBeNull();
    expect(linkedinUrlOf(42)).toBeNull();
  });

  it("is kept only on linkedin.com (P5c): any other site draws no link", () => {
    expect(linkedinUrlOf("https://uk.linkedin.com/in/avery")).toBe("https://uk.linkedin.com/in/avery");
    expect(linkedinUrlOf("https://LinkedIn.com/in/avery")).toBe("https://linkedin.com/in/avery");
    expect(linkedinUrlOf("https://example.com/in/avery")).toBeNull();
    expect(linkedinUrlOf("https://linkedin.com.evil.example/in/avery")).toBeNull();
    expect(linkedinUrlOf("https://notlinkedin.com/in/avery")).toBeNull();
    expect(linkedinUrlOf("https://linkedin.com@evil.example/in/avery")).toBeNull();
    expect(linkedinUrlOf("ftp://linkedin.com/in/avery")).toBeNull();
  });
});
