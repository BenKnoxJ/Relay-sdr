import { readFileSync } from "node:fs";
import path from "node:path";

import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MODULE_IDS, moduleOwnIds, researchRawSchema } from "../../../agents/research/output.schema";
import fixture from "../../../fixtures/research/smoke-a-insurance-direct-2026-09-13.json";
import config from "../../../tailwind.config";
import { ResearchPage } from "@/components/campaigns/ResearchPage";
import { ResearchReport } from "@/components/campaigns/ResearchReport";
import { overviewOf } from "@/lib/campaigns/overview";
import { researchSections } from "@/lib/campaigns/research";
import type { CampaignResearch, CampaignResearchPage } from "@/lib/campaigns/types";
import { campaignsCopy } from "@/lib/copy/campaigns";
import { reportCopy } from "@/lib/copy/report";
import { researchCopy } from "@/lib/copy/research";
import { shellCopy } from "@/lib/copy/shell";

import { briefFields, partialPack } from "../../lib/campaignPacks";

/**
 * The Campaign Research Pack (task 20): "What Relay learned" printed, or
 * saved as a PDF, from the research page. Drawn from the sanitised smoke-test
 * pack, the page and the pack side by side as the route draws them.
 *
 * jsdom does not paginate or apply print styles, so these hold what decides
 * the paper: what is in the pack, what is not, and which of the two trees the
 * print styles show. The paper itself is checked in a real browser and kept
 * with the design notes (`docs/design/task-20/`).
 */
const pack = researchRawSchema.parse(fixture.pack);
const research = researchSections(pack);
const overview = overviewOf(pack);
const NAME = "Claims ops at mid-sized UK insurers";
const pageOf = (data: CampaignResearch, summary: CampaignResearchPage["summary"]): CampaignResearchPage => ({
  id: "camp_1",
  name: NAME,
  brief: briefFields({ product: "Insights360", who: "Claims operations leads at mid-sized UK insurers, MGAs and claims handlers", channels: ["email", "linkedin"] }),
  summary,
  research: data,
});
const full = pageOf(research, { inShort: overview.inShort, startWith: overview.startWith });

/** The route's own composition: the page, and the pack beside it. */
const draw = (page = full, data = research) =>
  render(
    <>
      <ResearchPage name={page.name} campaignHref="/campaigns/camp_1" research={data} />
      <ResearchReport page={page} research={data} />
    </>,
  );
const report = () => screen.getByTestId("research-report");
const reportText = () => report().textContent ?? "";
const webSections = () => [...document.querySelectorAll<HTMLDetailsElement>("details[data-research-section]")];

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Print / save PDF", () => {
  it("is on the research page, and opens the browser's own print dialog: no request, and nothing on the page moves", () => {
    draw();
    const print = vi.spyOn(window, "print").mockImplementation(() => undefined);
    const fetch = vi.spyOn(globalThis, "fetch");
    webSections()[2]!.open = true;
    const before = { open: webSections().map((section) => section.open), hash: window.location.hash, href: window.location.href };

    fireEvent.click(screen.getByRole("button", { name: reportCopy.printAction }));

    expect(print).toHaveBeenCalledTimes(1);
    expect(fetch).not.toHaveBeenCalled();
    expect({ open: webSections().map((section) => section.open), hash: window.location.hash, href: window.location.href }).toEqual(before);
  });

  it("names the saved PDF after the pack while the dialog is open, and gives the page its title back when it closes", () => {
    document.title = "Relay";
    draw();
    window.dispatchEvent(new Event("beforeprint"));
    expect(document.title).toBe(`${NAME}${reportCopy.titleJoin}${shellCopy.appName} ${reportCopy.kind}`);
    window.dispatchEvent(new Event("afterprint"));
    expect(document.title).toBe("Relay");
  });

  it("prints the pack in place of the page: the page is hidden on paper and the pack is shown only there", () => {
    draw();
    expect(screen.getByTestId("research").className).toContain("print:hidden");
    expect(report().className.split(" ")).toEqual(expect.arrayContaining(["hidden", "print:block"]));
  });

  it("hides the app's own frame on paper: the nav and the page padding", () => {
    const layout = readFileSync(path.join(import.meta.dirname, "..", "..", "..", "src", "app", "(app)", "layout.tsx"), "utf8");
    expect(layout).toMatch(/<div className="[^"]*print:hidden[^"]*">\s*<Nav/);
    expect(layout).toContain("print:p-0");
  });

  it("builds the print styles it depends on", async () => {
    const postcss = (await import("postcss")).default;
    const tailwindcss = (await import("tailwindcss")).default;
    const css = (
      await postcss([tailwindcss({ ...config, content: [{ raw: "print:hidden print:block break-before-page break-after-page break-inside-avoid print:grid-cols-2" }] })]).process("@tailwind utilities;", {
        from: undefined,
      })
    ).css.replace(/\s+/g, " ");
    const print = css.slice(css.indexOf("@media print"));
    expect(print).toContain(".print\\:hidden { display: none");
    expect(print).toContain(".print\\:block { display: block");
    expect(css).toContain("break-before: page");
    expect(css).toContain("break-after: page");
    expect(css).toContain("break-inside: avoid");
  });
});

describe("The Campaign Research Pack", () => {
  it("has nothing to click: no navigation, no Expand all or Collapse all, no View, Show or Hide, no controls", () => {
    draw();
    for (const tag of ["details", "summary", "button", "select", "input", "nav"]) expect(report().querySelectorAll(tag)).toHaveLength(0);
    const text = reportText();
    for (const control of [researchCopy.expandAll, researchCopy.collapseAll, researchCopy.jumpToSection, researchCopy.inThisResearch, researchCopy.chooseSection, researchCopy.back, reportCopy.printAction]) {
      expect(text).not.toContain(control);
    }
    for (const label of Object.values(researchCopy.viewLabels)) expect(text).not.toContain(`${researchCopy.view} ${label}`);
    expect(text).not.toMatch(new RegExp(`\\b(${researchCopy.show}|${researchCopy.hide}) `));
  });

  it("opens with a Relay cover: the mark, what it is, who it is for, and which campaign", () => {
    draw();
    const cover = within(screen.getByTestId("report-cover"));
    expect(cover.getByText(shellCopy.appName)).toBeDefined();
    expect(cover.getByText(reportCopy.kind)).toBeDefined();
    expect(cover.getByTestId("report-classification").textContent).toBe(reportCopy.classification);
    expect(cover.getByRole("heading", { level: 1 }).textContent).toBe(NAME);
    // The brief's own who, as the rep wrote it: not the rep summary's Who line or a kind of buyer.
    expect(cover.getByTestId("report-brief-who").textContent).toBe(full.brief.who);
    expect(overview.inShort.lines).not.toContain(full.brief.who);
    expect(research.who.groups.map((group) => group.name)).not.toContain(full.brief.who);
    const field = (key: string) => cover.getByTestId(`report-field-${key}`).querySelector("dd")?.textContent;
    expect(field("product")).toBe("Insights360");
    expect(field("motion")).toBe("Direct");
    expect(field("where")).toBe("United Kingdom");
    expect(field("channels")).toBe("Email, LinkedIn");
    expect(field("researched")).toBe("13 Sep 2026");
  });

  it("counts the pack's own sources, and lists every one of them", () => {
    draw();
    const m19 = pack.modules.m19 as { sources: unknown[] };
    expect(research.sources).toBe(m19.sources.length);
    expect(within(screen.getByTestId("report-cover")).getByTestId("report-field-sources").querySelector("dd")?.textContent).toBe(String(m19.sources.length));
    const listed = within(screen.getByTestId("report-sources")).getAllByTestId("source-url");
    expect(listed.map((url) => url.textContent)).toEqual(research.sourceList.map((source) => source.url));
  });

  it("says who it is for on every page after the cover, with the page number, on A4", () => {
    draw();
    const style = report().querySelector("style")?.textContent ?? "";
    expect(style).toContain("size: A4");
    expect(style).toContain(`content: "${reportCopy.footer}"`);
    expect(style).toMatch(/counter\(page\).*counter\(pages\)/);
    expect(style).toMatch(/@page :first \{ @bottom-left \{ content: ""; \}/);
    // Nothing a rep or research wrote is put into a stylesheet.
    expect(style).not.toContain(NAME);
  });

  it("carries the eleven parts, numbered, in the page's own order", () => {
    draw();
    const parts = Object.keys(researchCopy.parts);
    const sections = parts.map((part) => screen.getByTestId(`report-${part}`));
    expect(sections.map((section) => section.querySelector("h2")?.textContent)).toEqual(Object.values(researchCopy.parts));
    expect(sections.map((section) => section.querySelector("header p")?.textContent)).toEqual(parts.map((_, index) => String(index + 1).padStart(2, "0")));
    expect(within(screen.getByTestId("report-contents")).getAllByRole("listitem").map((item) => item.textContent?.slice(2))).toEqual(Object.values(researchCopy.parts));
    // Each starts on a page of its own.
    for (const section of sections) expect(section.className).toContain("break-before-page");
  });

  it("lays out every part whole however the page is left: closed, opened, or all opened and closed again", async () => {
    draw();
    expect(webSections().every((section) => !section.open)).toBe(true);
    const whole = reportText();
    // The closed Gaps part on the page holds exactly the findings the pack prints.
    const findings = (root: HTMLElement) =>
      [...root.querySelectorAll('[data-testid="research-gap"], [data-testid="research-contradiction"]')].map((finding) => finding.querySelector("p")?.textContent);
    const onPaper = findings(screen.getByTestId("report-gaps"));
    expect(onPaper).toHaveLength(research.gaps.groups.reduce((sum, group) => sum + group.findings.length, 0));
    expect(onPaper).toEqual(findings(screen.getByTestId("research-gaps")));
    fireEvent.click(screen.getAllByTestId("expand-all")[0]!);
    expect(webSections().every((section) => section.open)).toBe(true);
    expect(reportText()).toBe(whole);
    // Collapse all wakes once the parts report themselves open.
    await waitFor(() => expect((screen.getAllByTestId("collapse-all")[0] as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getAllByTestId("collapse-all")[0]!);
    expect(webSections().every((section) => !section.open)).toBe(true);
    expect(reportText()).toBe(whole);
  });

  it("includes what the page keeps a click away: every group, the deals, the prices, the recipes and the day's other reports", () => {
    draw();
    const text = reportText();
    for (const group of [...research.who.groups, ...research.pains.groups, ...research.say.groups, ...research.prove.groups, ...research.companies.groups]) expect(text).toContain(group.name);
    for (const group of research.who.groups) if (group.deal.yearOneValue !== undefined) expect(text).toContain(group.deal.yearOneValue);
    for (const competitor of research.competition.competitors) for (const line of [...competitor.strengths, ...competitor.weaknesses]) expect(text).toContain(line.slice(0, 60));
    expect(within(screen.getByTestId("report-competition")).getAllByRole("row")).toHaveLength(research.competition.prices.length + 1);
    for (const group of research.companies.groups) expect(text).toContain(group.recipe.titles.join(", "));
    const alsoReported = research.market.timeline.flatMap((entry) => (entry.kind === "event" ? entry.alsoReported : []));
    expect(alsoReported.length).toBeGreaterThan(0);
    for (const item of alsoReported) expect(text).toContain(item.text);
    for (const angle of research.say.groups.flatMap((group) => group.angles)) expect(text).toContain(angle.text);
  });

  it("opens with the Overview's In short and Start with, as the campaign page shows them", () => {
    draw();
    const glance = within(screen.getByTestId("report-glance"));
    for (const line of overview.inShort.lines) expect(glance.getByText(line)).toBeDefined();
    expect(glance.getByTestId("report-in-short").textContent).toContain(overview.inShort.verdict ?? "");
    const start = glance.getByTestId("report-start-with").textContent ?? "";
    for (const value of [overview.startWith!.groupName, overview.startWith!.angle, overview.startWith!.whyNow, overview.startWith!.wrongIf]) expect(start).toContain(value);
  });

  it("marks what not to claim, what restricts a channel, and what is unresolved in words, not only colour", () => {
    draw();
    const dontClaim = within(screen.getByTestId("report-prove")).getByTestId("dont-claim");
    expect(dontClaim.className).toContain("border-warn");
    expect(dontClaim.querySelector("h3")?.textContent).toBe(researchCopy.dontClaimLabel);
    const barring = within(screen.getByTestId("report-contact")).getAllByTestId("contact-rule").filter((rule) => rule.dataset.bars === "true");
    expect(barring.length).toBeGreaterThan(0);
    for (const rule of barring) expect(rule.textContent).toContain(researchCopy.restricts);
    for (const kind of research.gaps.groups.map((group) => group.kind)) expect(within(screen.getByTestId("report-gaps")).getByText(researchCopy.gapGroups[kind])).toBeDefined();
  });

  it("keeps research's workings off paper: no internal name, no search it ran, and an address only in the source list", () => {
    draw();
    expect(report().querySelectorAll('[data-testid="gap-query"]')).toHaveLength(0);
    expect(reportText()).not.toContain(researchCopy.searched);
    const clone = report().cloneNode(true) as HTMLElement;
    clone.querySelectorAll('[data-testid="source-url"], style').forEach((element) => element.remove());
    const text = clone.textContent ?? "";
    expect(text).not.toMatch(/\bm[01]\d\b/);
    expect(text).not.toMatch(/i360\./);
    expect(text).not.toMatch(/archetype|\bpersonas?\b|repSummary|execSummary/i);
    expect(text).not.toMatch(/https?:\/\//);
    for (const id of MODULE_IDS.flatMap((module) => moduleOwnIds(pack, module))) expect(text).not.toContain(id);
  });

  it("has ids of its own, so a link in the PDF lands in the PDF and the page's links still land on the page", () => {
    draw();
    const ids = [...document.querySelectorAll("[id]")].map((element) => element.id);
    expect(new Set(ids).size).toBe(ids.length);
    const internal = [...report().querySelectorAll<HTMLAnchorElement>('a[href^="#"]')].map((link) => link.getAttribute("href")!.slice(1));
    expect(internal.length).toBeGreaterThan(0);
    for (const id of internal) {
      expect(id.startsWith("report-")).toBe(true);
      expect(report().contains(document.getElementById(id))).toBe(true);
    }
  });

  it("keeps long addresses and wide tables inside the page", () => {
    draw();
    expect(report().className).toContain("[overflow-wrap:anywhere]");
    for (const url of screen.getAllByTestId("source-url")) expect(url.className).toContain("[overflow-wrap:anywhere]");
    const table = within(screen.getByTestId("report-competition")).getByRole("table");
    expect(table.className).toContain("print:min-w-0");
    expect(table.parentElement?.className).toContain("print:overflow-visible");
  });
});

describe("A pack from research cut short", () => {
  const cut = partialPack();
  const cutResearch = researchSections(cut);
  const cutOverview = overviewOf(cut);
  const cutPage = pageOf(cutResearch, { inShort: cutOverview.inShort, startWith: cutOverview.startWith });

  it("prints every part research wrote, and says which it did not finish, without making anything up", () => {
    draw(cutPage, cutResearch);
    expect(screen.getByTestId("report-partial").textContent).toContain(campaignsCopy.planPartial);
    for (const part of Object.keys(researchCopy.parts) as (keyof typeof researchCopy.parts)[]) {
      const section = screen.getByTestId(`report-${part}`);
      expect(section.querySelector("h2")?.textContent).toBe(researchCopy.parts[part]);
      expect(within(section).queryAllByTestId("part-unwritten")).toHaveLength(cutResearch.unwritten[part].length === 0 ? 0 : 1);
    }
    // Research ranked nothing and chose no first campaign, so the pack does neither.
    expect(cutOverview.startWith).toBeNull();
    expect(screen.queryByTestId("report-start-with")).toBeNull();
    expect(reportText()).not.toContain(researchCopy.ranked);
    expect(reportText()).not.toMatch(/\bNaN\b|undefined|\b0 (pains|angles|objections|gaps|in buyers' own words|from others)\b/);
  });

  it("prints with no finished opening at all", () => {
    draw(pageOf(cutResearch, null), cutResearch);
    expect(screen.queryByTestId("report-in-short")).toBeNull();
    expect(screen.getByTestId("report-glance").textContent).toContain(reportCopy.glance);
    expect(screen.getAllByRole("heading", { level: 2 }).length).toBeGreaterThanOrEqual(11);
  });
});
