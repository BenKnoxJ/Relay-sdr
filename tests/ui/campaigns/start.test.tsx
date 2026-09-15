import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { StartForm } from "@/components/campaigns/StartForm";
import { toResearchBrief } from "@/lib/campaigns/brief";
import {
  EMPTY_SCOPE,
  HOW_LONG,
  HOW_MANY,
  PRODUCTS,
  REGIONS,
  countryName,
  startFromSentence,
  type StartResult,
  type StartSubmission,
} from "@/lib/campaigns/start";
import type { BriefFields } from "@/lib/campaigns/types";
import { campaignsCopy, startCopy } from "@/lib/copy/campaigns";

/** The facts version the page read for the org: version 2, pinned on a Thursday. */
const FACTS = { version: 2, activatedOn: "Thu 11 Sep" };

const push = vi.fn();
const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push, refresh }) }));

const SENTENCE =
  "Managed print dealers in the Midlands who resell service contracts, sell them Insights360, partners not end users";

const onStart = vi.fn<(submission: StartSubmission) => Promise<StartResult>>();

function start(props: { sentence?: string; connected?: boolean; facts?: typeof FACTS | null } = {}) {
  const sentence = props.sentence ?? SENTENCE;
  push.mockClear();
  onStart.mockReset();
  onStart.mockResolvedValue({ id: "camp_1" });
  return render(
    <StartForm
      sentence={sentence}
      prefilled={startFromSentence(sentence)}
      products={PRODUCTS}
      regions={REGIONS}
      howMany={HOW_MANY}
      howLong={HOW_LONG}
      facts={props.facts === undefined ? FACTS : props.facts}
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

const limits = () => screen.getByTestId("hard-limits");
const limitsToggle = () => limits().querySelector<HTMLButtonElement>("button[aria-expanded]")!;
const limitsFields = () => document.getElementById("hard-limits-fields")!;
const openLimits = () => {
  if (limitsToggle().getAttribute("aria-expanded") !== "true") fireEvent.click(limitsToggle());
};

/** Type a term into one of the hard limits' lists and add it. */
function addTerm(label: string, term: string) {
  const input = screen.getByLabelText(label);
  fireEvent.change(input, { target: { value: term } });
  fireEvent.click(within(input.parentElement!).getByRole("button", { name: startCopy.add }));
}

/** The card's fields outside the hard limits. */
const cardFields = () => screen.getAllByTestId("start-field").filter((field) => !limits().contains(field));

/**
 * Start (§23.1d, mock 3d): two steps on one page, every field a picker.
 *
 * The assertions are about the SHAPE of the card rather than its values: the
 * amendment of 2026-09-07 is that no field is a free-text box the rep has to
 * guess the vocabulary for, and a field that quietly became one would still
 * carry the right default.
 */
describe("Start", () => {
  it("shows the sentence, then the card Relay filled from it, with the hard limits closed", () => {
    start();

    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(startCopy.title);
    expect(screen.getByText(startCopy.note)).toBeDefined();
    expect(screen.getByText(startCopy.understood)).toBeDefined();
    // Product, motion, region, how many, channels and the customers question.
    expect(cardFields()).toHaveLength(6);
    expect(within(limits()).getAllByTestId("start-field")).toHaveLength(6);

    expect(limitsToggle().textContent).toContain(startCopy.limitsTitle);
    expect(limitsToggle().getAttribute("aria-expanded")).toBe("false");
    expect(limitsFields().hidden).toBe(true);
    expect(screen.getByTestId("limits-summary").textContent).toBe(startCopy.limitsNone);
  });

  it("has one Who: the rep's sentence, with no second box to change it in", () => {
    start();

    expect(screen.queryByLabelText(startCopy.fieldWho)).toBeNull();
    expect(screen.getAllByText(SENTENCE)).toHaveLength(1);
    expect(document.querySelectorAll("textarea")).toHaveLength(1);
    expect(screen.getByLabelText(startCopy.fieldCustomers).tagName).toBe("TEXTAREA");
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

  /**
   * The facts line is read from the org's row, never from a literal: the
   * page hands in what is active, and the card names it or says none is.
   */
  it("names the facts version the page read, not the one written on the product", () => {
    const { unmount } = start();

    expect(
      screen.getByText(
        `${startCopy.factsUpdated} ${FACTS.activatedOn}, ${startCopy.factsVersion} ${FACTS.version}. ${startCopy.factsMore}`,
      ),
    ).toBeDefined();
    const product = PRODUCTS[0];
    expect(document.body.textContent).not.toContain(`${startCopy.factsUpdated} ${product?.factsUpdated}`);
    unmount();

    start({ facts: null });
    expect(screen.getByText(`${startCopy.factsNone} ${startCopy.factsMore}`)).toBeDefined();
    expect(document.body.textContent).not.toContain(startCopy.factsUpdated);
  });

  it("says what the number means under how many: people, at the accounts Relay picks", () => {
    const { unmount } = start();

    // The sentence names no count, so the guess comes first and the meaning after it.
    expect(screen.getByText(`${startCopy.guessedHint} ${startCopy.howManyHint}`)).toBeDefined();
    unmount();

    start({ sentence: "30 people over 4 weeks at UK logistics firms" });
    expect(screen.getByText(startCopy.howManyHint)).toBeDefined();
    expect(screen.getByText(startCopy.channelsHint)).toBeDefined();
  });

  /**
   * 390px: "Read it" fell outside the sentence box when the sentence was
   * long. The box wraps and the button keeps its words on one line, so it
   * drops under the sentence rather than out of the box.
   */
  it("lets the sentence box wrap and keeps the button whole", () => {
    start();

    const button = screen.getByRole("button", { name: startCopy.edit });
    expect(button.className).toContain("shrink-0");
    expect(button.className).toContain("whitespace-nowrap");
    expect(button.parentElement?.className).toContain("flex-wrap");
    expect(screen.getByText(SENTENCE).className).toContain("min-w-0");
  });

  it("draws a guessed field dashed, and stops once the rep picks it", () => {
    start();

    // The sentence names no size and no length, so both are Relay's guess.
    expect(startFromSentence(SENTENCE).guessed).toContain("howMany");
    expect(screen.getByLabelText(startCopy.people).className).toContain("border-dashed");
    expect(screen.getAllByText(startCopy.guessedHint, { exact: false }).length).toBeGreaterThan(0);

    fireEvent.change(screen.getByLabelText(startCopy.people), { target: { value: "30" } });
    fireEvent.change(screen.getByLabelText(startCopy.weeks), { target: { value: "4" } });

    expect(screen.getByLabelText(startCopy.people).className).not.toContain("border-dashed");
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

  it("keeps the defaults §23.1d names when the sentence says nothing, and guesses no limit", () => {
    const draft = startFromSentence("");

    expect(draft.region).toBe(REGIONS[0]);
    expect(draft.howMany).toBe(20);
    expect(draft.weeks).toBe(3);
    // Email always on; Calls off until the rep ticks it.
    expect(draft.channels).toEqual(["email"]);
    expect(draft.product).toBe(PRODUCTS[0]?.name);
    expect(draft.scope).toEqual(EMPTY_SCOPE);
    expect(draft.existingCustomers).toBe("");

    // A sentence naming a place and a kind of practice still adds nothing: no parsing.
    expect(startFromSentence("independent vets in Orkney, practice owners").scope).toEqual(EMPTY_SCOPE);
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

  it("refuses to start until the mailbox is connected, says why, and says where to go", () => {
    const { unmount } = start({ connected: false });

    expect(screen.getByRole("button", { name: startCopy.start }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByTestId("start-blocked").textContent).toBe(startCopy.startBlockedMailbox);
    expect(screen.getByTestId("connect-first").textContent).toContain(startCopy.connectFirst);
    expect(screen.getByRole("link", { name: startCopy.connectLink }).getAttribute("href")).toBe("/settings");
    unmount();

    start({ connected: true });
    expect(screen.getByRole("button", { name: startCopy.start }).hasAttribute("disabled")).toBe(false);
    expect(screen.queryByTestId("start-blocked")).toBeNull();
    expect(screen.getByText(startCopy.startNote)).toBeDefined();
  });

  it("has no campaign name field and no mailbox picker", () => {
    start();

    for (const label of ["Name", "Campaign name", "Mailbox"]) {
      expect(screen.queryByLabelText(label)).toBeNull();
    }
  });

  it("shows no example taken from an old test brief, anywhere on the card", () => {
    const { unmount } = start();
    openLimits();
    fireEvent.click(screen.getByRole("button", { name: startCopy.edit }));

    const shown = [...document.querySelectorAll("[placeholder]")].map((element) => element.getAttribute("placeholder"));
    expect(shown.sort()).toEqual([startCopy.aliasesPlaceholder, startCopy.sizeFrom, startCopy.sizeTo].sort());
    for (const example of ["Orkney", "veterinary practice", "practice manager", "Managed print dealers"]) {
      expect(document.body.innerHTML).not.toContain(`placeholder="${example}`);
    }
    for (const key of ["placeholder", "placePlaceholder", "orgTypePlaceholder", "rolePlaceholder"]) {
      expect(key in startCopy).toBe(false);
    }
    unmount();
  });
});

/**
 * Calls start off. There is no saved Calls preference yet, so the chip is the
 * only way Calls reaches the brief; a sentence is no signal, since the people
 * Insights360 is sold to talk about calls all day.
 */
describe("Calls", () => {
  const callsChip = () => screen.getAllByTestId("channel-chip")[2];

  it("is off when the card opens, and is not sent", async () => {
    start();

    expect(callsChip()?.textContent).toBe(startCopy.channelCalls);
    expect(callsChip()?.getAttribute("aria-pressed")).toBe("false");
    pressStart();
    await waitFor(() => expect(onStart).toHaveBeenCalled());
    expect(sent().brief.channels).toEqual(["email"]);
  });

  it("is sent when the rep ticks it, and stops being a guess", async () => {
    start();

    fireEvent.click(callsChip()!);
    expect(callsChip()?.getAttribute("aria-pressed")).toBe("true");
    expect(callsChip()?.parentElement?.className).not.toContain("border-dashed");
    pressStart();
    await waitFor(() => expect(onStart).toHaveBeenCalled());
    expect(sent().brief.channels).toEqual(["email", "calls"]);
  });

  it("is never read out of the sentence", () => {
    expect(startFromSentence("UK law firms who handle a lot of client calls").channels).toEqual(["email"]);
    expect(startFromSentence("ops directors at UK logistics firms, call them on day 3").channels).toEqual(["email"]);
    // Nothing said about the channels, so they are still Relay's guess.
    expect(startFromSentence("ops directors at UK logistics firms, call them on day 3").guessed).toContain("channels");
  });

  it("keeps what the sentence says outright about email and LinkedIn", () => {
    const quiet = startFromSentence("care home groups in the South West, email only, no cold calls");
    expect(quiet.channels).toEqual(["email"]);
    expect(quiet.guessed).not.toContain("channels");

    const linkedin = startFromSentence("finance directors on LinkedIn");
    expect(linkedin.channels).toEqual(["email", "linkedin"]);
    expect(linkedin.guessed).not.toContain("channels");
  });
});

describe("Hard limits", () => {
  it("open on request, say what they are for, and close again", () => {
    start();

    openLimits();
    expect(limitsToggle().getAttribute("aria-expanded")).toBe("true");
    expect(limitsFields().hidden).toBe(false);
    expect(screen.getByText(startCopy.limitsHint)).toBeDefined();
    expect(screen.queryByTestId("limits-summary")).toBeNull();
    expect(within(limits()).getAllByTestId("start-field").map((field) => field.firstChild?.textContent)).toEqual([
      startCopy.fieldAlsoInclude,
      startCopy.fieldSize,
      startCopy.fieldPlaces,
      startCopy.fieldOrgTypes,
      startCopy.fieldRolesInclude,
      startCopy.fieldRolesExclude,
    ]);

    fireEvent.click(limitsToggle());
    expect(limitsToggle().getAttribute("aria-expanded")).toBe("false");
    expect(screen.getByTestId("limits-summary").textContent).toBe(startCopy.limitsNone);
  });

  it("send no scope at all when none is set, so research reads only the brief", async () => {
    start({ sentence: "UK law firms who handle a lot of client calls" });
    pressStart();
    await waitFor(() => expect(onStart).toHaveBeenCalled());

    expect(sent().brief.scope).toEqual(EMPTY_SCOPE);
    expect(toResearchBrief(sent().brief)).toEqual({
      product: "Insights360",
      motion: "direct",
      who: "UK law firms who handle a lot of client calls",
      region: "GB",
      howMany: 20,
      weeks: 3,
      channels: ["email"],
    });
  });

  it("send each limit the rep added, and nothing it did not, in the same scope as before", async () => {
    start();
    openLimits();

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
    expect(toResearchBrief(sent().brief).scope).toEqual({
      countries: ["GB", "IE"],
      places: [{ name: "Orkney", aliases: ["Orkney Islands", "Kirkwall"] }],
      orgTypes: ["veterinary practice"],
      size: { unit: "employees", min: 5, max: 50 },
      roles: { include: ["practice owner"], exclude: ["receptionist"] },
    });
  });

  it("are summarised in one line, in the section's order, once closed", () => {
    start();
    openLimits();

    fireEvent.click(screen.getByRole("button", { name: countryName("IE") }));
    fireEvent.change(screen.getByLabelText(startCopy.fieldPlaces), { target: { value: "Orkney" } });
    fireEvent.click(within(screen.getByLabelText(startCopy.fieldPlaces).parentElement!).getByRole("button", { name: startCopy.add }));
    addTerm(startCopy.fieldOrgTypes, "veterinary practice");
    fireEvent.change(screen.getByLabelText(startCopy.sizeFrom), { target: { value: "50" } });
    fireEvent.change(screen.getByLabelText(startCopy.sizeTo), { target: { value: "250" } });
    addTerm(startCopy.fieldRolesInclude, "practice owner");
    addTerm(startCopy.fieldRolesExclude, "receptionist");
    fireEvent.click(limitsToggle());

    const join = campaignsCopy.noteJoin;
    expect(screen.getByTestId("limits-summary").textContent).toBe(
      `${startCopy.limitsLead} ${countryName("IE")}${join}Orkney${join}veterinary practice${join}50 ${campaignsCopy.sizeTo} 250 ${campaignsCopy.sizeUnits.employees}${join}practice owner${join}${startCopy.limitsNever} receptionist`,
    );
  });

  it("take a term off again", () => {
    start();
    openLimits();
    addTerm(startCopy.fieldOrgTypes, "veterinary practice");
    expect(screen.getAllByTestId("term-chip")).toHaveLength(1);

    const remove = screen.getByRole("button", { name: `${startCopy.remove} veterinary practice` });
    // A 24px square to press (WCAG 2.5.8); jsdom has no layout, so the classes are what is checked here.
    expect(remove.className.split(" ")).toEqual(expect.arrayContaining(["h-6", "w-6"]));
    fireEvent.click(remove);
    expect(screen.queryAllByTestId("term-chip")).toHaveLength(0);
  });

  it("never offer the region as another country, and drop it when the region moves to it", async () => {
    start();
    openLimits();
    expect(screen.getAllByTestId("country-chip").map((chip) => chip.textContent)).toEqual([countryName("IE"), countryName("US")]);

    fireEvent.click(screen.getByRole("button", { name: countryName("IE") }));
    fireEvent.change(screen.getByLabelText(startCopy.fieldRegion), { target: { value: "IE" } });
    expect(screen.getAllByTestId("country-chip").map((chip) => chip.textContent)).toEqual([countryName("GB"), countryName("US")]);

    pressStart();
    await waitFor(() => expect(onStart).toHaveBeenCalled());
    expect(sent().brief.region).toBe("IE");
    expect(sent().brief.scope.extraCountries).toEqual([]);
  });

  it("will not start on a size that runs backwards, and say why", () => {
    start();
    openLimits();
    fireEvent.change(screen.getByLabelText(startCopy.sizeFrom), { target: { value: "50" } });
    fireEvent.change(screen.getByLabelText(startCopy.sizeTo), { target: { value: "5" } });

    expect(screen.getByText(startCopy.sizeBackwards)).toBeDefined();
    expect(screen.getByRole("button", { name: startCopy.start }).hasAttribute("disabled")).toBe(true);
  });

  it("leave the customers question outside them: it is a hint for research, not a limit", () => {
    start();

    expect(limits().contains(screen.getByLabelText(startCopy.fieldCustomers))).toBe(false);
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
      channels: ["email"],
      scope: EMPTY_SCOPE,
      existingCustomers: "",
    });
  });

  it("sends the sentence as who, in the rep's words", async () => {
    start({ sentence: "  Vets, Orkney.  Owners only " });
    pressStart();

    await waitFor(() => expect(onStart).toHaveBeenCalled());
    expect(sent().brief.who).toBe("Vets, Orkney.  Owners only");
  });

  it("waits while the sentence is open, says so beside the button, and starts once it is read", () => {
    start();

    fireEvent.click(screen.getByRole("button", { name: startCopy.edit }));
    expect(screen.getByRole("button", { name: startCopy.start }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByTestId("start-blocked").textContent).toBe(startCopy.startBlockedSentence);
    expect(screen.queryByText(startCopy.startNote)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: startCopy.readIt }));
    expect(screen.getByRole("button", { name: startCopy.start }).hasAttribute("disabled")).toBe(false);
    expect(screen.queryByTestId("start-blocked")).toBeNull();
    expect(screen.getByText(startCopy.startNote)).toBeDefined();
  });

  it("says the sentence reason, not the mailbox one, when the page opened with no sentence", () => {
    start({ sentence: "" });

    expect(screen.getByRole("button", { name: startCopy.start }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByTestId("start-blocked").textContent).toBe(startCopy.startBlockedSentence);
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

/** Edit brief (orchestrator A1, item 5): Start's card on a campaign's current brief. */
describe("Edit brief", () => {
  const current = {
    product: "Insights360",
    motion: "direct" as const,
    who: "veterinary practices in Orkney",
    region: "GB",
    howMany: 10,
    weeks: 3,
    channels: ["email" as const],
    scope: {
      extraCountries: [],
      places: [{ name: "Orkney", aliases: ["Kirkwall"] }],
      orgTypes: ["veterinary practice"],
      size: null,
      rolesInclude: [],
      rolesExclude: [],
    },
    existingCustomers: "",
  };

  function editing(connected = false, brief: BriefFields = current) {
    push.mockClear();
    refresh.mockClear();
    onStart.mockReset();
    onStart.mockResolvedValue({ id: "camp_1" });
    return render(
      <StartForm
        sentence=""
        prefilled={{ ...brief, guessed: [] }}
        products={PRODUCTS}
        regions={REGIONS}
        howMany={HOW_MANY}
        howLong={HOW_LONG}
        facts={FACTS}
        mailboxConnected={connected}
        onStart={onStart}
        edit={{ campaignName: "Vets in Orkney", cancelHref: "/campaigns/camp_1" }}
      />,
    );
  }

  it("opens on the current brief, with no sentence step, nothing guessed and its own Who", () => {
    editing();

    expect(screen.getByRole("heading", { name: startCopy.editTitle })).toBeDefined();
    expect(screen.getByText("Vets in Orkney")).toBeDefined();
    expect(screen.getByTestId("edit-intro").textContent).toBe(startCopy.editIntro);
    expect(screen.queryByText(startCopy.understood)).toBeNull();
    expect(screen.queryByRole("button", { name: startCopy.readIt })).toBeNull();
    expect((screen.getByLabelText(startCopy.fieldWho) as HTMLTextAreaElement).value).toBe(current.who);
    expect(screen.getByRole("link", { name: startCopy.editCancel }).getAttribute("href")).toBe("/campaigns/camp_1");
  });

  it("opens the hard limits when the brief has them, so a locked limit is never hidden", () => {
    editing();

    expect(limitsToggle().getAttribute("aria-expanded")).toBe("true");
    expect(limitsFields().hidden).toBe(false);
    // The rep's own terms, as chips: the place (with its other names) and the kind of organisation.
    const chips = screen.getAllByTestId("term-chip").map((chip) => chip.firstChild?.textContent ?? "");
    expect(chips.some((chip) => chip.startsWith("Orkney") && chip.includes("Kirkwall"))).toBe(true);
    expect(chips).toContain("veterinary practice");
  });

  it("keeps them closed when the brief has none", () => {
    editing(false, { ...current, scope: EMPTY_SCOPE });

    expect(limitsToggle().getAttribute("aria-expanded")).toBe("false");
    expect(screen.getByTestId("limits-summary").textContent).toBe(startCopy.limitsNone);
  });

  it("sends the rep's changed fields, without waiting on a mailbox, and goes back to the campaign", async () => {
    editing(false);

    fireEvent.change(screen.getByLabelText(startCopy.fieldWho), { target: { value: "vets and pet clinics in Orkney" } });
    fireEvent.click(screen.getByRole("button", { name: startCopy.editSubmit }));

    await waitFor(() => expect(push).toHaveBeenCalledWith("/campaigns/camp_1?again=1"));
    expect(onStart).toHaveBeenCalledTimes(1);
    const { brief, startRequestId } = onStart.mock.calls[0]![0];
    expect(brief).toEqual({ ...current, who: "vets and pet clinics in Orkney" });
    expect(startRequestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(screen.queryByTestId("connect-first")).toBeNull();
  });

  it("shows the line the server sends back, such as nothing having changed", async () => {
    editing();
    onStart.mockResolvedValue({ error: campaignsCopy.briefUnchanged });

    fireEvent.click(screen.getByRole("button", { name: startCopy.editSubmit }));

    expect((await screen.findByTestId("start-error")).textContent).toBe(campaignsCopy.briefUnchanged);
    expect(push).not.toHaveBeenCalled();
  });
});
