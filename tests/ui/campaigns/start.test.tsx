import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { StartForm } from "@/components/campaigns/StartForm";
import { startCopy } from "@/lib/copy/campaigns";
import { HOW_LONG, HOW_MANY, PRODUCTS, REGIONS, startFromSentence } from "@/lib/fixtures/campaigns";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));

const SENTENCE =
  "Managed print dealers in the Midlands who resell service contracts, sell them Insights360, partners not end users";

function start(props: { sentence?: string; connected?: boolean } = {}) {
  const sentence = props.sentence ?? SENTENCE;
  return render(
    <StartForm
      sentence={sentence}
      prefilled={startFromSentence(sentence)}
      products={PRODUCTS}
      regions={REGIONS}
      howMany={HOW_MANY}
      howLong={HOW_LONG}
      mailboxConnected={props.connected ?? true}
    />,
  );
}

/**
 * Start (§23.1d, mock 3d): two steps on one page, every field a picker.
 *
 * The assertions are about the SHAPE of the card rather than its values: the
 * amendment of 2026-09-07 is that no field is a free-text box the rep has to
 * guess the vocabulary for, and a field that quietly became one would still
 * carry the right default.
 */
describe("Start", () => {
  it("shows the sentence, then the card Relay filled from it", () => {
    start();

    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(startCopy.title);
    expect(screen.getByText(startCopy.note)).toBeDefined();
    // Twice: the sentence itself, and the Who field it pre-filled.
    expect(screen.getAllByText(SENTENCE).length).toBeGreaterThan(0);
    expect(screen.getByText(startCopy.understood)).toBeDefined();
    expect(screen.getAllByTestId("start-field")).toHaveLength(6);
  });

  it("offers every value the signed section allows, and nothing else", () => {
    start();

    const options = (label: string) =>
      Array.from(screen.getByLabelText(label).querySelectorAll("option")).map((option) =>
        option.getAttribute("value"),
      );

    expect(options(startCopy.fieldProduct)).toEqual(PRODUCTS.map((product) => product.name));
    expect(options(startCopy.fieldRegion)).toEqual([...REGIONS]);
    expect(options(startCopy.people)).toEqual(HOW_MANY.map(String));
    expect(options(startCopy.weeks)).toEqual(HOW_LONG.map(String));
    expect(screen.getAllByTestId("motion-chip").map((chip) => chip.textContent)).toEqual([
      startCopy.motionDirect,
      startCopy.motionChannel,
    ]);
    expect(screen.getAllByTestId("channel-chip").map((chip) => chip.textContent)).toEqual([
      startCopy.channelEmail,
      startCopy.channelLinkedin,
      startCopy.channelCalls,
    ]);
  });

  it("names the facts file behind the one product", () => {
    start();

    const product = PRODUCTS[0];
    expect(product).toBeDefined();
    expect(
      screen.getByText(
        `${startCopy.factsUpdated} ${product?.factsUpdated}, ${startCopy.factsVersion} ${product?.factsVersion}. ${startCopy.factsMore}`,
      ),
    ).toBeDefined();
  });

  it("draws a guessed field dashed, and stops once the rep picks it", () => {
    start();

    // The sentence names no size and no length, so both are Relay's guess.
    expect(startFromSentence(SENTENCE).guessed).toContain("howMany");
    expect(screen.getByLabelText(startCopy.people).className).toContain("border-dashed");
    expect(screen.getByText(startCopy.guessedHint)).toBeDefined();

    fireEvent.change(screen.getByLabelText(startCopy.people), { target: { value: "30" } });
    fireEvent.change(screen.getByLabelText(startCopy.weeks), { target: { value: "4" } });

    expect(screen.getByLabelText(startCopy.people).className).not.toContain("border-dashed");
    expect(screen.queryByText(startCopy.guessedHint)).toBeNull();
  });

  it("only reads a number that carries its unit", () => {
    // "10 or more sites" is not a size of ten, and must not render solid as
    // though the rep had asked for one.
    const vague = startFromSentence("independent vets with 10 or more sites in Scotland");
    expect(vague.guessed).toContain("howMany");
    expect(vague.howMany).toBe(20);

    const said = startFromSentence("30 people over 4 weeks at UK logistics firms");
    expect(said.guessed).not.toContain("howMany");
    expect(said.howMany).toBe(30);
    expect(said.weeks).toBe(4);
  });

  it("turns calls off when the rep said so, in the words they said it in", () => {
    const quiet = startFromSentence("care home groups in the South West, email only, no cold calls");
    expect(quiet.channels).toEqual(["email"]);
    expect(quiet.guessed).not.toContain("channels");

    const loud = startFromSentence("ops directors at UK logistics firms, call them on day 3");
    expect(loud.channels).toEqual(["email", "calls"]);
  });

  it("keeps the defaults §23.1d names when the sentence says nothing", () => {
    const draft = startFromSentence("");

    expect(draft.region).toBe(REGIONS[0]);
    expect(draft.howMany).toBe(20);
    expect(draft.weeks).toBe(3);
    // Email always on, Calls on by default.
    expect(draft.channels).toEqual(["email", "calls"]);
    expect(draft.product).toBe(PRODUCTS[0]?.name);
  });

  it("has Email always on, and lets the other two off", () => {
    start();

    const [email, linkedin] = screen.getAllByTestId("channel-chip");
    expect(email?.hasAttribute("disabled")).toBe(true);
    expect(email?.getAttribute("aria-pressed")).toBe("true");

    expect(linkedin?.getAttribute("aria-pressed")).toBe("false");
    if (linkedin !== undefined) fireEvent.click(linkedin);
    expect(screen.getAllByTestId("channel-chip")[1]?.getAttribute("aria-pressed")).toBe("true");
  });

  it("refuses to start until the mailbox is connected, and says where to go", () => {
    const { unmount } = start({ connected: false });

    expect(screen.getByRole("button", { name: startCopy.start }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByTestId("connect-first").textContent).toContain(startCopy.connectFirst);
    expect(screen.getByRole("link", { name: startCopy.connectLink }).getAttribute("href")).toBe(
      "/settings",
    );
    unmount();

    start({ connected: true });
    expect(screen.getByRole("button", { name: startCopy.start }).hasAttribute("disabled")).toBe(false);
    expect(screen.getByText(startCopy.startNote)).toBeDefined();
  });

  it("lands on the campaign in Researching, and spends nothing doing it", () => {
    start();

    fireEvent.click(screen.getByRole("button", { name: startCopy.start }));

    expect(push).toHaveBeenCalledWith(`/campaigns/${startFromSentence(SENTENCE).landsOn}?started=1`);
  });

  it("has no campaign name field and no mailbox picker", () => {
    start();

    for (const label of ["Name", "Campaign name", "Mailbox"]) {
      expect(screen.queryByLabelText(label)).toBeNull();
    }
  });
});

describe("Editing the sentence", () => {
  it("closes without navigating when nothing was changed", () => {
    start();
    push.mockClear();

    fireEvent.click(screen.getByRole("button", { name: startCopy.edit }));
    fireEvent.click(screen.getByRole("button", { name: startCopy.readIt }));

    // Nothing to re-read, so nothing is pushed and the box is closed again.
    expect(push).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: startCopy.edit })).toBeDefined();
  });

  it("goes back through the pre-fill when the sentence changed", () => {
    start();
    push.mockClear();

    fireEvent.click(screen.getByRole("button", { name: startCopy.edit }));
    fireEvent.change(screen.getByLabelText(startCopy.question), {
      target: { value: "vets in Scotland, 30 people over 4 weeks" },
    });
    fireEvent.click(screen.getByRole("button", { name: startCopy.readIt }));

    expect(push).toHaveBeenCalledWith(
      `/campaigns/new?said=${encodeURIComponent("vets in Scotland, 30 people over 4 weeks")}`,
    );
  });
});
