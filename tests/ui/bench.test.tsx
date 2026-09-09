import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ItemLine, sourceLine } from "@/components/ItemLine";
import { Row } from "@/components/Row";
import { RenderFixture } from "@/app/(bench)/bench/renderers";
import { AGENT_KINDS } from "@/lib/agents/definitions";
import { listFixtureNames, readFixture } from "@/lib/bench/fixture";
import { draftCopy } from "@/lib/copy/draft";
import { planCopy } from "@/lib/copy/plan";
import { peopleCopy } from "@/lib/copy/people";

import type { Item } from "../../agents/research/output.schema";
import type { RevealedPerson } from "../../agents/leadgen/output.schema";

/**
 * Plan conformance guard 3: every signed definition has a fixture that renders.
 *
 * Not "a fixture exists" and not "the fixture validates" — both of those are
 * `tests/bench/fixtures.test.ts`. This is the render, in the real components,
 * because the whole reason the bench is a page in the app rather than a JSON
 * dump is that a pack can validate perfectly and still read as nonsense on the
 * screen a rep meets it on.
 *
 * These tests live in `tests/ui/` and not in `tests/bench/` where the task
 * brief put them: `vitest.config.ts` gives a DOM only to `tests/ui/**`, and its
 * own comment says a component test written anywhere else should fail loudly
 * rather than be silently uncollected.
 */

const item: Item = {
  id: "pain-sampling",
  text: "Quality checking covers about two per cent of calls.",
  accessedAt: "2026-09-08",
  publishedAt: "2026-07-03",
  speaker: "Helen Marsh",
  role: "Claims Operations Director",
  evidence: { urls: ["https://example.com/a"], primary: false, domains: ["example.com"] },
  confidence: "weak",
};

const person: RevealedPerson = {
  id: "p1",
  lushaId: "l-1",
  name: "Priya Raman",
  title: "Head of Operations",
  company: "Brightline Logistics",
  domain: "brightline.example",
  country: "GB",
  city: "Leeds",
  hasEmail: true,
  score: 7,
  whyPicked: "Exact title match at a firm on your starting list.",
  rank: 1,
  companyKey: "brightline.example",
  email: "priya.raman@brightline.example",
  status: "verified",
};

describe("every signed definition has a fixture that renders", () => {
  for (const kind of AGENT_KINDS) {
    for (const name of listFixtureNames(kind)) {
      it(`${kind}/${name}`, () => {
        const fixture = readFixture(kind, name);
        const { container } = render(
          <RenderFixture kind={kind} output={fixture.output} input={fixture.input} />,
        );
        // Something was drawn, and it is not the "there is no screen for this"
        // fallback for a kind that has one.
        expect(container.textContent?.trim()).not.toBe("");
      });
    }
  }
});

describe("the research pack in the plan cards", () => {
  it("draws the five signed cards, with the first one open", () => {
    const fixture = readFixture("research", "insurance-direct");
    render(<RenderFixture kind="research" output={fixture.output} input={fixture.input} />);

    for (const title of Object.values(planCopy.card)) {
      expect(screen.getByRole("heading", { name: title }), title).toBeTruthy();
    }
    expect(screen.getByText(planCopy.card.pains).closest("section")?.dataset.open).toBe("");
  });

  it("puts a confidence word and a source on every line of the open card", () => {
    const fixture = readFixture("research", "insurance-direct");
    render(<RenderFixture kind="research" output={fixture.output} input={fixture.input} />);

    const open = screen.getByText(planCopy.card.pains).closest("section");
    if (open === null || open === undefined) throw new Error("no open card");
    const lines = within(open).getAllByText(
      (_, element) => element?.className.includes("type-body") === true && element.tagName === "SPAN",
    );
    expect(lines.length).toBeGreaterThan(0);
  });
});

describe("ItemLine", () => {
  it("says a guess, never speculative, and never a number", () => {
    render(<ItemLine item={{ ...item, confidence: "speculative", inferredFrom: "the two lines above", evidence: { urls: [], primary: false, domains: [] } }} />);
    expect(screen.getByText(planCopy.confidence.speculative)).toBeTruthy();
    expect(screen.queryByText("speculative")).toBeNull();
  });

  it("colours strong with the accent and a guess with warn", () => {
    const { container, rerender } = render(<ItemLine item={{ ...item, confidence: "strong", evidence: { urls: ["https://a.example/1", "https://b.example/1", "https://c.example/1"], primary: true, domains: ["a.example", "b.example", "c.example"] } }} />);
    expect(container.querySelector(".text-action")).not.toBeNull();

    rerender(<ItemLine item={{ ...item, confidence: "speculative", inferredFrom: "a hunch", evidence: { urls: [], primary: false, domains: [] } }} />);
    expect(container.querySelector(".text-warn")).not.toBeNull();
  });

  it("names what a guess was inferred from, since it has no source to name", () => {
    expect(
      sourceLine({ ...item, confidence: "speculative", inferredFrom: "the two lines above", evidence: { urls: [], primary: false, domains: [] } }),
    ).toContain("the two lines above");
  });

  it("prefers the source's own words when there are any", () => {
    render(<ItemLine item={{ ...item, quote: "We answer the phone but we cannot prove it." }} />);
    expect(screen.getByText(/We answer the phone/)).toBeTruthy();
  });
});

describe("Row", () => {
  it("shows the email status as its one chip", () => {
    render(<Row person={person} rank={1} />);
    expect(screen.getByText(peopleCopy.status.verified)).toBeTruthy();
  });

  it("gives a person who needs you the warn tone", () => {
    const { container } = render(<Row person={{ ...person, status: "needs_you" }} />);
    expect(screen.getByText(peopleCopy.status.needs_you)).toBeTruthy();
    expect(container.querySelector(".text-warn")).not.toBeNull();
  });
});

describe("the draft card", () => {
  it("draws the opener's evidence, the body and three buttons that do nothing", () => {
    const fixture = readFixture("outreach", "first-email");
    render(<RenderFixture kind="outreach" output={fixture.output} input={fixture.input} />);

    // The evidence line, from the lookup item the opener points at.
    expect(screen.getByText(/Told the trade press in June/)).toBeTruthy();

    const buttons = screen.getAllByRole("button");
    expect(buttons.length).toBe(3);
    for (const button of buttons) expect(button).toHaveProperty("disabled", true);
  });

  /**
   * The opener points at an item in the agent's INPUT, so the output schema
   * cannot catch a reference that resolves to nothing. Before this was said out
   * loud, a dangling reference drew the same card as the legitimate "no usable
   * fact about this person" case — the defect passing as a clean draft on the
   * one screen built to find it.
   */
  it("says so when the opener points at something that is not there", () => {
    const fixture = readFixture("outreach", "first-email");
    const input = fixture.input as { lookup: { items: { id: string }[] } };
    const broken = {
      ...input,
      lookup: { ...input.lookup, items: input.lookup.items.map((i) => ({ ...i, id: "not-the-one" })) },
    };

    render(<RenderFixture kind="outreach" output={fixture.output} input={broken} />);
    expect(screen.getByText(draftCopy.openerMissing)).toBeTruthy();
    expect(screen.queryByText(draftCopy.noPersonFact)).toBeNull();
  });
});
