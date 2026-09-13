import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { MODULE_IDS, moduleOwnIds, researchRawSchema } from "../../../agents/research/output.schema";
import fixture from "../../../fixtures/research/smoke-a-insurance-direct-2026-09-13.json";
import { ResearchPage } from "@/components/campaigns/ResearchPage";
import { researchSections } from "@/lib/campaigns/research";
import { campaignsCopy } from "@/lib/copy/campaigns";
import { researchCopy } from "@/lib/copy/research";

import { partialPack } from "../../lib/campaignPacks";

/**
 * "What Relay learned" as a rep reads it, drawn from the smoke-test pack.
 * Everything a closed "Show" holds is in the document too (`<details>`), so
 * each check below reads the whole page, open or not.
 */
const pack = researchRawSchema.parse(fixture.pack);
const research = researchSections(pack);

const draw = (data = research) => render(<ResearchPage name="Claims ops at mid-sized UK insurers" campaignHref="/campaigns/camp_1" research={data} />);
const pageText = () => screen.getByTestId("research").textContent ?? "";
const occurrences = (text: string, needle: string) => text.split(needle).length - 1;

describe("What Relay learned", () => {
  it("says what it is, how much it rests on, and the way back", () => {
    draw();
    expect(screen.getByRole("heading", { level: 1, name: researchCopy.title })).toBeDefined();
    expect(screen.getByTestId("research-back").getAttribute("href")).toBe("/campaigns/camp_1");
    expect(screen.getByTestId("research-meta").textContent).toBe(`78 ${researchCopy.metaSources}${campaignsCopy.noteJoin}${researchCopy.metaResearched} 13 Sep 2026`);
  });

  it("jumps to each of the eleven parts, on one page", () => {
    draw();
    const links = within(screen.getByTestId("research-jump")).getAllByRole("link");
    expect(links).toHaveLength(11);
    for (const link of links) {
      const id = link.getAttribute("href")!.slice(1);
      expect(document.getElementById(id)?.tagName).toBe("SECTION");
    }
    expect(screen.getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent)).toEqual(Object.values(researchCopy.parts));
  });

  it("shows no internal name anywhere: no part id, no fact id, no record id, no url as text", () => {
    draw();
    const text = pageText();
    expect(text).not.toMatch(/\bm[01]\d\b/);
    expect(text).not.toMatch(/i360\./);
    expect(text).not.toMatch(/archetype|\bpersonas?\b|repSummary|execSummary/i);
    expect(text).not.toMatch(/https?:\/\//);
    for (const id of MODULE_IDS.flatMap((module) => moduleOwnIds(pack, module))) expect(text).not.toContain(id);
  });

  it("keeps buyers' words apart from everyone else's, and says whose the others are", () => {
    draw();
    for (const group of screen.getAllByTestId("pain-group")) {
      const buyer = within(group).getByTestId("buyer-words").textContent ?? "";
      for (const voice of within(group).queryAllByTestId("other-voice")) {
        const say = /“([^”]+)”/.exec(voice.textContent ?? "")?.[1] ?? "";
        expect(say.length).toBeGreaterThan(0);
        expect(buyer).not.toContain(say);
        expect(voice.textContent).not.toContain(researchCopy.voices.practitioner);
      }
    }
    expect(screen.getAllByTestId("other-voices")[0]?.textContent).toContain(researchCopy.otherVoicesLabel);
  });

  it("puts a date on the timeline once, and does not repeat it among the coming dates", () => {
    draw();
    const dates = screen.getAllByTestId("timeline-date").map((date) => date.textContent);
    expect(dates.filter((date) => date === "22 Oct 2026")).toHaveLength(1);
    expect(screen.getAllByTestId("also-expected").some((line) => line.textContent?.startsWith("22 October 2026"))).toBe(false);
    expect(screen.getAllByTestId("venue-on-timeline").length).toBeGreaterThan(0);
  });

  it("shows each hard boundary and each thing not to claim once, the second all in one place", () => {
    draw();
    const boundaries = screen.getAllByTestId("boundary").map((line) => line.textContent);
    expect(new Set(boundaries).size).toBe(boundaries.length);
    const lines = within(screen.getByTestId("dont-claim")).getAllByTestId("dont-claim-line");
    const d = research.prove.dontClaim;
    expect(lines).toHaveLength(d.lead.length + d.product.length + d.brand.length + d.imply.length + d.proof.length);
    expect(screen.getAllByTestId("dont-claim-line")).toHaveLength(lines.length);
    for (const entry of d.imply) expect(occurrences(pageText(), entry.text)).toBe(1);
  });

  it("says an unknown size is unknown, and never gives it a size", () => {
    draw();
    const sizes = screen.getAllByTestId("firm-size").map((size) => size.textContent ?? "");
    expect(sizes).toHaveLength(8);
    const unknown = sizes.filter((size) => size.startsWith(campaignsCopy.sizeUnknown));
    expect(unknown).toHaveLength(3);
    for (const size of unknown) expect(size).not.toMatch(new RegExp(`\\((${campaignsCopy.sizeConfirmed}|${campaignsCopy.sizeEstimated})\\)`));
  });

  it("gives every gap why it matters, every question to ask, every contradiction what it means, and the searches only behind a Show", () => {
    draw();
    const text = pageText();
    expect(screen.getAllByTestId("research-gap")).toHaveLength(11);
    for (const gap of research.gaps.groups.flatMap((group) => group.findings.flatMap((finding) => (finding.kind === "gap" ? [finding.gap] : [])))) {
      expect(text).toContain(gap.whyItMatters);
    }
    expect(screen.getAllByTestId("gap-question")).toHaveLength(6);
    expect(screen.getAllByTestId("research-contradiction")).toHaveLength(7);
    for (const query of screen.getAllByTestId("gap-query")) expect(query.closest("details")?.hasAttribute("open")).toBe(false);
    expect(screen.getByTestId("gap-group-ask").textContent).toContain(researchCopy.gapGroups.ask);
  });

  it("makes a rule that restricts a channel hard to miss", () => {
    draw();
    const barring = screen.getAllByTestId("contact-rule").filter((rule) => rule.getAttribute("data-bars") === "true");
    expect(barring).toHaveLength(3);
    for (const rule of barring) {
      expect(rule.textContent).toContain(researchCopy.restricts);
      expect(rule.className).toContain("border-warn");
    }
    expect(screen.getAllByTestId("channel-restricted")).toHaveLength(2);
  });

  it("lists all 78 sources by title, with the url only where the link goes", () => {
    draw();
    const sources = screen.getAllByTestId("research-source");
    expect(sources).toHaveLength(78);
    const first = within(sources[0]!).getAllByRole("link")[0]!;
    expect(first.textContent).toBe(research.sourceList[0]!.title);
    expect(first.getAttribute("href")).toBe(research.sourceList[0]!.url);
  });

  it("gives every item a confidence word and a source", () => {
    draw();
    for (const item of screen.getAllByTestId("pack-item")) {
      expect(within(item).getAllByTestId("confidence")).toHaveLength(1);
      const hasLink = within(item).queryAllByRole("link").length > 0;
      const saysWhy = item.textContent?.includes(campaignsCopy.noSource) === true || item.textContent?.includes(campaignsCopy.noSourceFrom) === true;
      expect(hasLink || saysWhy).toBe(true);
    }
  });

  it("cannot be widened by a long string", () => {
    draw();
    for (const part of screen.getByTestId("research").querySelectorAll("section")) {
      expect(part.className).toContain("min-w-0");
      expect(part.className).toContain("[overflow-wrap:anywhere]");
    }
  });
});

describe("What Relay learned, when a limit cut the research short", () => {
  it("draws what was written, and says plainly which parts were not", () => {
    draw(researchSections(partialPack()));
    expect(screen.getByTestId("research-partial").textContent).toContain(campaignsCopy.planPartial);
    expect(within(screen.getByTestId("research-pains")).getByTestId("part-unwritten").textContent).toBe(researchCopy.unwrittenAll);
    expect(within(screen.getByTestId("research-market")).getByTestId("part-unwritten").textContent).toContain(researchCopy.unwrittenSome);
    expect(within(screen.getByTestId("research-sources")).queryByTestId("part-unwritten")).toBeNull();
    expect(screen.queryAllByTestId("timeline-entry")).toHaveLength(0);
    expect(screen.getAllByTestId("research-group").length).toBeGreaterThan(0);
  });
});
