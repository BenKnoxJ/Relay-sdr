import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { completeModule, planCards, researchRawSchema } from "../../../agents/research/output.schema";
import fixture from "../../../fixtures/research/smoke-a-insurance-direct-2026-09-13.json";
import { Overview } from "@/components/campaigns/Overview";
import { overviewOf } from "@/lib/campaigns/overview";
import { campaignsCopy } from "@/lib/copy/campaigns";
import { researchCopy } from "@/lib/copy/research";

/**
 * The Overview as a rep reads it, drawn from the smoke-test pack. What is
 * pinned is what the first campaign page got wrong: headings over the wrong
 * lines, a wall of gaps with raw links in it, regulator words counted as the
 * buyer's, and a source count of only what the cards cited.
 */
const pack = researchRawSchema.parse(fixture.pack);
const overview = overviewOf(pack);
const summary = completeModule(pack, "repSummary")!;

const draw = () => render(<Overview overview={overview} editHref="/campaigns/camp_1/edit" />);
const openAll = () => {
  for (const toggle of screen.getAllByRole("button").filter((button) => button.getAttribute("aria-expanded") === "false")) fireEvent.click(toggle);
};

describe("the Overview", () => {
  it("is the six parts, and none of the old card headings", () => {
    draw();
    for (const label of [
      campaignsCopy.inShortLabel,
      campaignsCopy.startWithLabel,
      campaignsCopy.groupsLabel,
      campaignsCopy.painLabel,
      campaignsCopy.firmsLabel,
      campaignsCopy.checkFirstLabel,
    ]) {
      expect(screen.getByRole("heading", { name: label })).toBeDefined();
    }
    for (const old of [campaignsCopy.cardWho, campaignsCopy.cardPain, campaignsCopy.cardUnknowns, campaignsCopy.cardHook]) {
      expect(screen.queryByText(old)).toBeNull();
    }
  });

  it("gives the five summary lines one by one, research's view, and the real source count", () => {
    draw();
    expect(screen.getAllByTestId("in-short-text").map((line) => line.textContent)).toEqual(summary.lines);
    expect(screen.getAllByTestId("in-short-label").map((label) => label.textContent)).toEqual([...campaignsCopy.inShortLines]);
    expect(screen.getByTestId("in-short-view").textContent).toContain(completeModule(pack, "execSummary")!.verdict);
    expect(screen.getByTestId("overview-sources").textContent).toBe(`${campaignsCopy.basedOn} 78 ${campaignsCopy.fromSources}`);
  });

  it("starts with the rank-1 campaign's own reason and when it is the wrong call, not the market's strongest trigger", () => {
    draw();
    const start = screen.getByTestId("overview-start-with").textContent ?? "";
    expect(start).toContain(overview.startWith!.whyNow);
    expect(start).toContain(overview.startWith!.wrongIf);
    expect(start).not.toContain(planCards(pack).hook!.whyNow.text);
  });

  it("does not lead the pains with who to reach, and keeps other voices out of the buyer's words", () => {
    draw();
    const pain = screen.getByTestId("overview-pain");
    expect(pain.textContent).not.toContain(summary.lines[0]!);
    const buyerWords = within(pain).getByTestId("buyer-words").textContent ?? "";
    for (const phrase of overview.pain!.otherVoices) expect(buyerWords).not.toContain(phrase.say);
    fireEvent.click(screen.getByTestId("pain-more"));
    const others = within(pain).getByTestId("other-voices").textContent ?? "";
    for (const phrase of overview.pain!.otherVoices) expect(others).toContain(phrase.say);
    expect(pain.textContent).toContain(campaignsCopy.otherVoicesLabel);
  });

  it("shows two pains and one buyer phrase first, and the rest behind one show", () => {
    draw();
    const pain = screen.getByTestId("overview-pain");
    expect(within(pain).getAllByTestId("pack-item")).toHaveLength(3);
    expect(within(pain).queryByTestId("other-voices")).toBeNull();
    expect(screen.getByTestId("pain-more").textContent).toBe(`${campaignsCopy.overviewShow} ${campaignsCopy.allPainsAndLanguage}`);

    fireEvent.click(screen.getByTestId("pain-more"));
    const { pains, buyerWords, otherVoices } = overview.pain!;
    expect(within(pain).getAllByTestId("pack-item")).toHaveLength(pains.length + buyerWords.length + otherVoices.length);
  });

  it("shows research's example firms as examples, with an unknown size said as unknown", () => {
    draw();
    expect(screen.getAllByTestId("overview-firm")).toHaveLength(8);
    expect(screen.getByTestId("overview-firms").textContent).toContain(campaignsCopy.firmsNote);
    expect(screen.getAllByText(new RegExp(campaignsCopy.sizeUnknown.replace(/\./g, "\\.")))).toHaveLength(3);
    expect(screen.getByTestId("overview-groups").textContent).toContain(campaignsCopy.groupsNote);
  });

  it("asks at most three questions first, and shows no url and no search anywhere", () => {
    draw();
    expect(screen.getAllByTestId("check-first-question")).toHaveLength(3);
    expect(screen.queryAllByTestId("check-first-more-question")).toHaveLength(0);
    fireEvent.click(screen.getByTestId("questions-more"));
    expect(screen.getAllByTestId("check-first-more-question").map((item) => item.textContent)).toEqual(overview.checkFirst.more.map((q) => q.question));
    expect(screen.getByTestId("gaps-more").textContent).toBe(`${campaignsCopy.overviewShow} ${campaignsCopy.allGapsLabel}`);
    expect(screen.getByTestId("overview-check-first").textContent).toContain(summary.lines[3]!);
    openAll();
    const text = screen.getByTestId("overview").textContent ?? "";
    expect(text).not.toMatch(/https?:\/\//);
    for (const gap of overview.gaps) for (const query of gap.queriesTried) expect(text).not.toContain(query);
  });

  it("opens every gap as its own finding, with why it matters, and a link as its host", () => {
    draw();
    fireEvent.click(screen.getByTestId("gaps-more"));
    expect(screen.getAllByTestId("overview-gap")).toHaveLength(11);
    expect(screen.getAllByTestId("overview-contradiction")).toHaveLength(overview.contradictions.length);
    const unreadable = screen.getAllByRole("link").filter((link) => (link.getAttribute("href") ?? "").includes("reddit.com/r/callcentres"));
    expect(unreadable.length).toBe(2);
    for (const link of unreadable) expect(link.textContent).toBe("reddit.com");
    for (const gap of overview.gaps) expect(screen.getByTestId("overview").textContent).toContain(gap.whyItMatters);
  });

  it("gives every item it shows a source and a confidence word", () => {
    draw();
    openAll();
    const items = screen.getAllByTestId("pack-item");
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      expect(within(item).getAllByTestId("confidence")).toHaveLength(1);
      const hasLink = within(item).queryAllByRole("link").length > 0;
      const saysWhy = item.textContent?.includes(campaignsCopy.noSource) === true || item.textContent?.includes(campaignsCopy.noSourceFrom) === true;
      expect(hasLink || saysWhy).toBe(true);
    }
  });

  it("cannot be widened by a long string: the column may shrink and text wraps anywhere", () => {
    draw();
    const root = screen.getByTestId("overview");
    expect(root.className).toContain("min-w-0");
    expect(root.className).toContain("[overflow-wrap:anywhere]");
    for (const part of root.querySelectorAll("section")) expect(part.className).toContain("min-w-0");
  });

  it("offers Edit brief", () => {
    draw();
    expect(screen.getByTestId("overview-edit-brief").getAttribute("href")).toBe("/campaigns/camp_1/edit");
  });

  it("offers one way into everything research found, and none when it is not given one", () => {
    render(<Overview overview={overview} researchHref="/campaigns/camp_1/research" />);
    const link = screen.getByTestId("overview-research-link");
    expect(link.getAttribute("href")).toBe("/campaigns/camp_1/research");
    expect(link.textContent).toBe(researchCopy.openLink);
  });

  it("has no way into the research view without a page to go to", () => {
    draw();
    expect(screen.queryByTestId("overview-research-link")).toBeNull();
  });
});
