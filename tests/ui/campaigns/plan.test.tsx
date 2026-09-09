import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import goodPack from "../../../agents/research/fixtures/output.good.json";
import { researchOutputSchema } from "../../../agents/research/output.schema";
import { PlanCards } from "@/components/campaigns/PlanCards";
import { campaignsCopy } from "@/lib/copy/campaigns";
import { getCampaign } from "@/lib/fixtures/campaigns";

/**
 * The plan cards are the research surface (§23.1c).
 *
 * What is checked here is the rule, not the wording: every rendered item shows
 * a source and one of four confidence words. A card that dropped an item, or
 * showed one bare, is the failure this exists to catch — because the pack is
 * the evidence a rep decides on, and an item without a source is a claim.
 */
const pack = (() => {
  const found = getCampaign("managed-print-partners-midlands");
  if (found?.pack == null) throw new Error("the plan-ready fixture has no research behind it");
  return found.pack;
})();

function openEveryCard() {
  for (const card of screen.getAllByTestId("plan-card")) {
    const toggle = within(card).getAllByRole("button")[0];
    if (toggle !== undefined) fireEvent.click(toggle);
  }
}

describe("the plan, and the research behind it", () => {
  it("is five cards", () => {
    render(<PlanCards pack={pack} />);

    expect(screen.getAllByTestId("plan-card").map((card) => card.textContent?.slice(0, 40))).toHaveLength(5);
    for (const title of [
      campaignsCopy.cardWho,
      campaignsCopy.cardHook,
      campaignsCopy.cardPain,
      campaignsCopy.cardFirms,
      campaignsCopy.cardUnknowns,
    ]) {
      expect(screen.getByText(title)).toBeDefined();
    }
  });

  it("gives every rendered item a source and a confidence word", () => {
    render(<PlanCards pack={pack} />);
    openEveryCard();

    const items = screen.getAllByTestId("pack-item");
    expect(items.length).toBeGreaterThan(0);

    for (const item of items) {
      expect(within(item).getAllByTestId("confidence")).toHaveLength(1);
      const hasLink = within(item).queryAllByRole("link").length > 0;
      // A source, or the sentence that says there is none and what stood in
      // for one. Never neither.
      const saysWhy =
        item.textContent?.includes(campaignsCopy.noSource) === true ||
        item.textContent?.includes(campaignsCopy.noSourceFrom) === true;
      expect(hasLink || saysWhy).toBe(true);
    }
  });

  it("uses all four words, and calls the fourth one a guess", () => {
    render(<PlanCards pack={pack} />);
    openEveryCard();

    const words = new Set(screen.getAllByTestId("confidence").map((chip) => chip.textContent));
    expect(words).toEqual(
      new Set([
        campaignsCopy.confidenceStrong,
        campaignsCopy.confidenceModerate,
        campaignsCopy.confidenceWeak,
        campaignsCopy.confidenceGuess,
      ]),
    );
    // The schema's own word never reaches a screen.
    expect(screen.queryByText("speculative")).toBeNull();
  });

  it("holds everything the pack holds for it", () => {
    render(<PlanCards pack={pack} />);
    openEveryCard();

    for (const group of pack.archetypes) {
      expect(screen.getByText(group.name)).toBeDefined();
      expect(screen.getByText(group.situation)).toBeDefined();
      for (const pain of group.pains) {
        expect(screen.getAllByText(pain.text).length).toBeGreaterThan(0);
      }
      for (const phrase of group.language) {
        expect(screen.getAllByText(new RegExp(phrase.say)).length).toBeGreaterThan(0);
      }
    }
    expect(screen.getAllByText(pack.hook.text).length).toBeGreaterThan(0);
    expect(screen.getAllByText(pack.hook.whyNow.text).length).toBeGreaterThan(0);
    for (const firm of pack.seedFirms) {
      expect(screen.getAllByText(new RegExp(firm.name)).length).toBeGreaterThan(0);
      expect(screen.getAllByText(firm.signal.text).length).toBeGreaterThan(0);
    }
    for (const unknown of pack.unknowns) {
      expect(screen.getAllByText(unknown.text).length).toBeGreaterThan(0);
      for (const query of unknown.queriesTried) {
        expect(screen.getAllByText(new RegExp(query)).length).toBeGreaterThan(0);
      }
    }
  });

  it("shows the targeting recipe as the words lead gen is handed", () => {
    render(<PlanCards pack={pack} />);
    openEveryCard();

    expect(screen.getAllByText(new RegExp(pack.recipe.titles[0] ?? "")).length).toBeGreaterThan(0);
    expect(screen.getAllByText(new RegExp(pack.recipe.industries[0] ?? "")).length).toBeGreaterThan(0);
  });
});

describe("an item with no confidence word", () => {
  /**
   * The contract refuses it, and the page never sees it. This is the guard the
   * "source and confidence on every item" rule actually rests on: a screen that
   * hid such an item would look identical to one that never received it.
   */
  it("is rejected by the contract rather than hidden by the card", () => {
    const bad = structuredClone(goodPack) as {
      archetypes: { pains: Record<string, unknown>[] }[];
    };
    const pain = bad.archetypes[0]?.pains[0];
    if (pain === undefined) throw new Error("the good fixture has no pain to break");
    delete pain.confidence;

    const parsed = researchOutputSchema.safeParse(bad);
    expect(parsed.success).toBe(false);
  });

  it("is rejected when it cites nothing and does not say so", () => {
    const bad = structuredClone(goodPack) as {
      archetypes: { pains: Record<string, unknown>[] }[];
    };
    const pain = bad.archetypes[0]?.pains[0];
    if (pain === undefined) throw new Error("the good fixture has no pain to break");
    pain.evidence = { urls: [], primary: false, domains: [] };

    expect(researchOutputSchema.safeParse(bad).success).toBe(false);
  });
});
