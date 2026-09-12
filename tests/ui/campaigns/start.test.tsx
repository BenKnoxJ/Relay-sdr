import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { StartForm } from "@/components/campaigns/StartForm";
import {
  HOW_LONG,
  HOW_MANY,
  PRODUCTS,
  REGIONS,
  countryName,
  startFromSentence,
  type StartDefaults,
  type StartResult,
  type StartSubmission,
} from "@/lib/campaigns/start";
import { campaignsCopy, startCopy } from "@/lib/copy/campaigns";
import { getProfile, resetProfile, saveProfile } from "@/lib/fixtures/repProfile";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));

const SENTENCE =
  "Managed print dealers in the Midlands who resell service contracts, sell them Insights360, partners not end users";

const onStart = vi.fn<(submission: StartSubmission) => Promise<StartResult>>();

function start(props: { sentence?: string; connected?: boolean; defaults?: StartDefaults } = {}) {
  const sentence = props.sentence ?? SENTENCE;
  push.mockClear();
  onStart.mockReset();
  onStart.mockResolvedValue({ id: "camp_1" });
  return render(
    <StartForm
      sentence={sentence}
      prefilled={startFromSentence(sentence, props.defaults)}
      products={PRODUCTS}
      regions={REGIONS}
      howMany={HOW_MANY}
      howLong={HOW_LONG}
      mailboxConnected={props.connected ?? true}
      onStart={onStart}
    />,
  );
}

const pressStart = () => fireEvent.click(screen.getByRole("button", { name: startCopy.start }));

/** What the last press of Start sent. */
const sent = (): StartSubmission => {
  const call = onStart.mock.calls.at(-1);
  if (call === undefined) throw new Error("Start was not pressed");
  return call[0];
};

/** Type a term into one of Who exactly's lists and add it. */
function addTerm(label: string, term: string) {
  const input = screen.getByLabelText(label);
  fireEvent.change(input, { target: { value: term } });
  fireEvent.click(within(input.parentElement!).getByRole("button", { name: startCopy.add }));
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
  it("shows the sentence, then the card Relay filled from it, then who exactly", () => {
    start();

    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(startCopy.title);
    expect(screen.getByText(startCopy.note)).toBeDefined();
    // Twice: the sentence itself, and the Who field it pre-filled.
    expect(screen.getAllByText(SENTENCE).length).toBeGreaterThan(0);
    expect(screen.getByText(startCopy.understood)).toBeDefined();
    // Six signed fields, and the seven of who exactly.
    expect(screen.getAllByTestId("start-field")).toHaveLength(13);
    expect(within(screen.getByTestId("who-exactly")).getAllByTestId("start-field")).toHaveLength(7);
  });

  it("offers every value the signed section allows, and nothing else", () => {
    start();

    const options = (label: string) =>
      Array.from(screen.getByLabelText(label).querySelectorAll("option")).map((option) => option.getAttribute("value"));
    const names = (label: string) =>
      Array.from(screen.getByLabelText(label).querySelectorAll("option")).map((option) => option.textContent);

    expect(options(startCopy.fieldProduct)).toEqual(PRODUCTS.map((product) => product.name));
    // Stored as the ISO code research reads, shown by name.
    expect(options(startCopy.fieldRegion)).toEqual([...REGIONS]);
    expect(names(startCopy.fieldRegion)).toEqual(REGIONS.map(countryName));
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

  it("keeps the defaults §23.1d names when the sentence says nothing, and guesses nothing about who exactly", () => {
    const draft = startFromSentence("");

    expect(draft.region).toBe(REGIONS[0]);
    expect(draft.howMany).toBe(20);
    expect(draft.weeks).toBe(3);
    // Email always on, Calls on by default.
    expect(draft.channels).toEqual(["email", "calls"]);
    expect(draft.product).toBe(PRODUCTS[0]?.name);
    expect(draft.scope).toEqual({ extraCountries: [], places: [], orgTypes: [], size: null, rolesInclude: [], rolesExclude: [] });
    expect(draft.existingCustomers).toBe("");

    // A sentence naming a place and a kind of practice still adds nothing: no parsing.
    expect(startFromSentence("independent vets in Orkney, practice owners").scope.places).toEqual([]);
  });

  it("reads a country the sentence names as its code", () => {
    expect(startFromSentence("accountancy firms in Ireland").region).toBe("IE");
    expect(startFromSentence("accountancy firms in Ireland").guessed).not.toContain("region");
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
    expect(screen.getByRole("link", { name: startCopy.connectLink }).getAttribute("href")).toBe("/settings");
    unmount();

    start({ connected: true });
    expect(screen.getByRole("button", { name: startCopy.start }).hasAttribute("disabled")).toBe(false);
    expect(screen.getByText(startCopy.startNote)).toBeDefined();
  });

  it("has no campaign name field and no mailbox picker", () => {
    start();

    for (const label of ["Name", "Campaign name", "Mailbox"]) {
      expect(screen.queryByLabelText(label)).toBeNull();
    }
  });
});

describe("Pressing Start", () => {
  it("sends the card as the rep confirmed it, then lands on the new campaign", async () => {
    start();
    pressStart();

    await waitFor(() => expect(push).toHaveBeenCalledWith("/campaigns/camp_1?started=1"));
    expect(onStart).toHaveBeenCalledTimes(1);
    expect(sent().startRequestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(sent().brief).toEqual({
      product: "Insights360",
      motion: "channel",
      who: SENTENCE,
      region: "GB",
      howMany: 20,
      weeks: 3,
      channels: ["email", "calls"],
      scope: { extraCountries: [], places: [], orgTypes: [], size: null, rolesInclude: [], rolesExclude: [] },
      existingCustomers: "",
    });
  });

  it("keeps who exactly as the rep wrote it", async () => {
    start();
    fireEvent.change(screen.getByLabelText(startCopy.fieldWho), { target: { value: "  Vets, Orkney.  Owners only " } });
    pressStart();

    await waitFor(() => expect(onStart).toHaveBeenCalled());
    expect(sent().brief.who).toBe("  Vets, Orkney.  Owners only ");
  });

  it("sends each part of who exactly the rep added, and nothing it did not", async () => {
    start();

    fireEvent.click(screen.getByRole("button", { name: countryName("IE") }));
    fireEvent.change(screen.getByLabelText(startCopy.fieldPlaces), { target: { value: "Orkney" } });
    fireEvent.change(screen.getByLabelText(startCopy.aliasesLabel), { target: { value: "Orkney Islands, Kirkwall" } });
    fireEvent.click(within(screen.getByLabelText(startCopy.fieldPlaces).parentElement!).getByRole("button", { name: startCopy.add }));
    addTerm(startCopy.fieldOrgTypes, "veterinary practice");
    // Enter adds a term too, and a second spelling of the same one is not a second term.
    fireEvent.change(screen.getByLabelText(startCopy.fieldOrgTypes), { target: { value: "Veterinary practice" } });
    fireEvent.keyDown(screen.getByLabelText(startCopy.fieldOrgTypes), { key: "Enter" });
    addTerm(startCopy.fieldRolesInclude, "practice owner");
    addTerm(startCopy.fieldRolesExclude, "receptionist");
    fireEvent.change(screen.getByLabelText(startCopy.sizeFrom), { target: { value: "5" } });
    fireEvent.change(screen.getByLabelText(startCopy.sizeTo), { target: { value: "50" } });
    fireEvent.change(screen.getByLabelText(startCopy.fieldCustomers), { target: { value: "Two practices in Kirkwall" } });

    expect(screen.getByText(`Orkney (${campaignsCopy.alsoCalled} Orkney Islands, Kirkwall)`)).toBeDefined();
    pressStart();
    await waitFor(() => expect(onStart).toHaveBeenCalled());

    expect(sent().brief.scope).toEqual({
      extraCountries: ["IE"],
      places: [{ name: "Orkney", aliases: ["Orkney Islands", "Kirkwall"] }],
      orgTypes: ["veterinary practice"],
      size: { unit: "employees", min: 5, max: 50 },
      rolesInclude: ["practice owner"],
      rolesExclude: ["receptionist"],
    });
    expect(sent().brief.existingCustomers).toBe("Two practices in Kirkwall");
  });

  it("takes a term off again", () => {
    start();
    addTerm(startCopy.fieldOrgTypes, "veterinary practice");
    expect(screen.getAllByTestId("term-chip")).toHaveLength(1);

    const remove = screen.getByRole("button", { name: `${startCopy.remove} veterinary practice` });
    // A 24px square to press (WCAG 2.5.8); jsdom has no layout, so the classes are what is checked here.
    expect(remove.className.split(" ")).toEqual(expect.arrayContaining(["h-6", "w-6"]));
    fireEvent.click(remove);
    expect(screen.queryAllByTestId("term-chip")).toHaveLength(0);
  });

  it("never offers the region as an extra country, and drops it when the region moves to it", async () => {
    start();
    expect(screen.getAllByTestId("country-chip").map((chip) => chip.textContent)).toEqual([countryName("IE"), countryName("US")]);

    fireEvent.click(screen.getByRole("button", { name: countryName("IE") }));
    fireEvent.change(screen.getByLabelText(startCopy.fieldRegion), { target: { value: "IE" } });
    expect(screen.getAllByTestId("country-chip").map((chip) => chip.textContent)).toEqual([countryName("GB"), countryName("US")]);

    pressStart();
    await waitFor(() => expect(onStart).toHaveBeenCalled());
    expect(sent().brief.region).toBe("IE");
    expect(sent().brief.scope.extraCountries).toEqual([]);
  });

  it("will not start on a size that runs backwards, and says why", () => {
    start();
    fireEvent.change(screen.getByLabelText(startCopy.sizeFrom), { target: { value: "50" } });
    fireEvent.change(screen.getByLabelText(startCopy.sizeTo), { target: { value: "5" } });

    expect(screen.getByText(startCopy.sizeBackwards)).toBeDefined();
    expect(screen.getByRole("button", { name: startCopy.start }).hasAttribute("disabled")).toBe(true);
  });

  it("shows the line it is given, and a second press sends the same request id", async () => {
    start();
    onStart.mockResolvedValueOnce({ error: startCopy.cannotStart });

    pressStart();
    expect(await screen.findByTestId("start-error")).toBeDefined();
    expect(screen.getByTestId("start-error").textContent).toBe(startCopy.cannotStart);
    expect(push).not.toHaveBeenCalled();

    pressStart();
    await waitFor(() => expect(push).toHaveBeenCalledWith("/campaigns/camp_1?started=1"));
    const [first, second] = onStart.mock.calls.map((call) => call[0].startRequestId);
    expect(second).toBe(first);
  });
});

describe("Editing the sentence", () => {
  it("closes without navigating when nothing was changed", () => {
    start();

    fireEvent.click(screen.getByRole("button", { name: startCopy.edit }));
    fireEvent.click(screen.getByRole("button", { name: startCopy.readIt }));

    // Nothing to re-read, so nothing is pushed and the box is closed again.
    expect(push).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: startCopy.edit })).toBeDefined();
  });

  it("goes back through the pre-fill when the sentence changed", () => {
    start();

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

/**
 * The rep's Calls default (§23.1d Channels ↔ §23.1f card 4). Settings owns
 * the toggle; Start reads it once, on the server, as the default for the
 * Calls chip. A default and not a lock: the sentence wins when it mentions
 * calls, and the chip on the form wins over both for that one campaign.
 */
describe("The rep's Calls default", () => {
  afterEach(() => {
    resetProfile();
  });

  const callsChip = () => screen.getAllByTestId("channel-chip")[2];
  const channelsFrame = () => callsChip()?.parentElement;

  it("lands with Calls ticked when the default is on", () => {
    start({ defaults: { callByDefault: true } });

    expect(callsChip()?.textContent).toBe(startCopy.channelCalls);
    expect(callsChip()?.getAttribute("aria-pressed")).toBe("true");
  });

  it("lands with Calls unticked when the default is off, in the same words", () => {
    start({ defaults: { callByDefault: false } });

    expect(callsChip()?.textContent).toBe(startCopy.channelCalls);
    expect(callsChip()?.getAttribute("aria-pressed")).toBe("false");
    // Still Relay's guess, drawn dashed: the sentence said nothing about calls.
    expect(channelsFrame()?.className).toContain("border-dashed");
    // Email is still always on, and the chip count is unchanged.
    expect(screen.getAllByTestId("channel-chip")).toHaveLength(3);
    expect(screen.getAllByTestId("channel-chip")[0]?.getAttribute("aria-pressed")).toBe("true");
  });

  it("is on when nothing was said about it, as §23.1d names the default", () => {
    expect(startFromSentence(SENTENCE).channels).toContain("calls");
    expect(startFromSentence(SENTENCE, {}).channels).toContain("calls");
  });

  it("lets the sentence win over the toggle, both ways", () => {
    const quiet = startFromSentence("care home groups in the South West, email only, no cold calls", {
      callByDefault: true,
    });
    expect(quiet.channels).toEqual(["email"]);

    const loud = startFromSentence("ops directors at UK logistics firms, call them on day 3", {
      callByDefault: false,
    });
    expect(loud.channels).toEqual(["email", "calls"]);

    // A sentence that names LinkedIn and not calls has not spoken about calls.
    const linkedin = startFromSentence("finance directors on LinkedIn", { callByDefault: false });
    expect(linkedin.channels).toEqual(["email", "linkedin"]);
  });

  it("takes the rep's choice on the form for this campaign, and leaves the profile alone", async () => {
    saveProfile({ callByDefault: false });
    start({ defaults: { callByDefault: getProfile().callByDefault } });

    expect(callsChip()?.getAttribute("aria-pressed")).toBe("false");
    const chip = callsChip();
    if (chip !== undefined) fireEvent.click(chip);

    // The form carries the rep's value: ticked, and no longer a guess.
    expect(callsChip()?.getAttribute("aria-pressed")).toBe("true");
    expect(channelsFrame()?.className).not.toContain("border-dashed");

    pressStart();
    await waitFor(() => expect(push).toHaveBeenCalledWith("/campaigns/camp_1?started=1"));
    expect(sent().brief.channels).toEqual(["email", "calls"]);

    // The profile is the default, not a lock, and Start never writes it.
    expect(getProfile().callByDefault).toBe(false);
  });

  it("can be turned off on the form when the default is on, the same way", () => {
    start({ defaults: { callByDefault: true } });

    const chip = callsChip();
    if (chip !== undefined) fireEvent.click(chip);

    expect(callsChip()?.getAttribute("aria-pressed")).toBe("false");
    expect(getProfile().callByDefault).toBe(true);
  });
});
