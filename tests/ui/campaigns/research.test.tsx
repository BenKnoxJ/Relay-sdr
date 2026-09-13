import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
const sections = () => [...document.querySelectorAll<HTMLDetailsElement>("details[data-research-section]")];

describe("What Relay learned", () => {
  it("says what it is, how much it rests on, and the way back", () => {
    draw();
    expect(screen.getByRole("heading", { level: 1, name: researchCopy.title })).toBeDefined();
    expect(screen.getByTestId("research-back").getAttribute("href")).toBe("/campaigns/camp_1");
    expect(screen.getByTestId("research-meta").textContent).toBe(`78 ${researchCopy.metaSources}${campaignsCopy.noteJoin}${researchCopy.metaResearched} 13 Sep 2026`);
  });

  it("navigates to each of the eleven parts by its own id: a list on a wide screen, one control on a phone", () => {
    draw();
    const ids = Object.keys(researchCopy.parts);
    const links = within(screen.getByTestId("research-nav")).getAllByRole("link");
    expect(links.map((link) => link.getAttribute("href"))).toEqual(ids.map((id) => `#${id}`));
    const options = within(screen.getByTestId("research-jump-select")).getAllByRole("option").slice(1);
    expect(options.map((option) => option.getAttribute("value"))).toEqual(ids);
    for (const id of ids) expect(document.getElementById(id)?.tagName).toBe("SECTION");
    expect(screen.getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent)).toEqual(Object.values(researchCopy.parts));
    // On a phone the parts are one select, never a row that scrolls sideways.
    expect(screen.getByTestId("research-jump").className).not.toMatch(/overflow-x|nowrap/);
    expect(screen.getByTestId("research-nav").className).toContain("hidden");
  });

  it("closes every part by default, and each closed part still says what it holds", () => {
    draw();
    expect(sections()).toHaveLength(11);
    for (const section of sections()) expect(section.open).toBe(false);
    const previews = screen.getAllByTestId("section-preview").map((preview) => preview.textContent ?? "");
    expect(previews).toHaveLength(11);
    for (const preview of previews) expect(preview).toMatch(/\d/);
    const preview = (part: string) => within(screen.getByTestId(`research-${part}`)).getByTestId("section-preview").textContent;
    expect(preview("gaps")).toBe("11 gaps · 7 contradictions · 6 questions worth asking");
    expect(preview("competition")).toBe("5 competitors researched · 6 prices compared · plus what happens if they do nothing");
    expect(preview("companies")).toBe("8 example firms across 4 kinds of buyer · 3 with size not known");
    expect(preview("contact")).toBe("8 rules across Email and LinkedIn · 3 restrict a channel");
    expect(preview("sources")).toBe("78 sources · read 13 Sep 2026");
    expect(preview("market")).toBe("17 dated moments · 6 coming up, the next on 24 Sep 2026 · 8 parts of the market");
    expect(within(screen.getByTestId("research-gaps")).getByTestId("section-toggle").textContent).toContain(`${researchCopy.view} ${researchCopy.viewLabels.gaps}`);
  });

  it("opens and closes each part from its summary", () => {
    draw();
    for (const section of sections()) {
      fireEvent.click(section.querySelector("summary")!);
      expect(section.open).toBe(true);
      fireEvent.click(section.querySelector("summary")!);
      expect(section.open).toBe(false);
    }
  });

  it("opens all eleven with Expand all and closes them with Collapse all, and nothing inside them", () => {
    draw();
    const inner = () => [...screen.getByTestId("research").querySelectorAll("details:not([data-research-section])")].map((details) => (details as HTMLDetailsElement).open);
    const before = inner();
    fireEvent.click(screen.getAllByTestId("expand-all")[0]!);
    expect(sections().every((section) => section.open)).toBe(true);
    expect(inner()).toEqual(before);
    fireEvent.click(screen.getAllByTestId("collapse-all")[0]!);
    expect(sections().every((section) => !section.open)).toBe(true);
    expect(inner()).toEqual(before);
  });

  it("keeps the groups inside a part as they were: research's rank 1 open, the rest one click away", () => {
    draw();
    fireEvent.click(screen.getAllByTestId("expand-all")[0]!);
    const groups = screen.getAllByTestId("research-group") as HTMLDetailsElement[];
    expect(groups[0]!.open).toBe(true);
    expect(groups.slice(1).every((group) => !group.open)).toBe(true);
    fireEvent.click(groups[1]!.querySelector("summary")!);
    expect(groups[1]!.open).toBe(true);
    expect((screen.getAllByTestId("group-deal")[0] as HTMLDetailsElement).open).toBe(false);
  });

  it("opens the part a link lands on, from the list, the phone control and a link inside the page", async () => {
    draw();
    fireEvent.click(within(screen.getByTestId("research-nav")).getByRole("link", { name: researchCopy.jump.gaps }));
    expect((screen.getByTestId("section-gaps") as HTMLDetailsElement).open).toBe(true);
    fireEvent.change(screen.getByTestId("research-jump-select"), { target: { value: "contact" } });
    expect((screen.getByTestId("section-contact") as HTMLDetailsElement).open).toBe(true);
    expect(window.location.hash).toBe("#contact");
    // A pain in the second group, from a link in another part: the part and the group open.
    act(() => {
      window.history.replaceState(null, "", "#pain-2-1");
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    await waitFor(() => expect((screen.getByTestId("section-pains") as HTMLDetailsElement).open).toBe(true));
    expect((document.getElementById("pain-2-1")!.closest("details") as HTMLDetailsElement).open).toBe(true);
    window.history.replaceState(null, "", " ");
  });

  it("hides nothing: every item is on the page whether its part is open or closed", () => {
    draw();
    const closed = screen.getAllByTestId("pack-item").length;
    fireEvent.click(screen.getAllByTestId("expand-all")[0]!);
    expect(screen.getAllByTestId("pack-item")).toHaveLength(closed);
    expect(screen.getAllByTestId("research-source")).toHaveLength(78);
    for (const section of sections()) expect(section.querySelector("summary + div")?.childElementCount).toBeGreaterThan(0);
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

  it("opens what it has, gives a part with nothing written nothing to open, and ranks nothing without the ranking", () => {
    draw(researchSections(partialPack()));
    // Written: the market's case, the kinds of buyer, what to say, don't claim (m00 and m09), the sources.
    for (const part of ["market", "who", "say", "prove", "sources"]) expect(screen.getByTestId(`section-${part}`)).toBeDefined();
    // Not written at all: said so, and nothing to open.
    for (const part of ["pains", "competition", "companies", "gather", "contact", "gaps"]) {
      expect(screen.queryByTestId(`section-${part}`)).toBeNull();
      expect(within(screen.getByTestId(`research-${part}`)).getByTestId("part-unwritten").textContent).toBe(researchCopy.unwrittenAll);
    }
    // A closed part never counts what was not written as nothing found.
    for (const preview of screen.getAllByTestId("section-preview")) expect(preview.textContent).not.toMatch(/(^|· )0 /);
    expect(within(screen.getByTestId("research-prove")).getByTestId("section-preview").textContent).toMatch(/things not to claim$/);
    fireEvent.click(screen.getAllByTestId("expand-all")[0]!);
    const text = pageText();
    // No campaign ranking (m16) was written: no rank, no lead angle, no reason of its own.
    expect(text).not.toContain(`${researchCopy.ranked} 1`);
    expect(text).not.toContain(researchCopy.leadWith);
    expect(text).not.toMatch(/\bm[01]\d\b|i360\.|https?:\/\//);
  });
});
