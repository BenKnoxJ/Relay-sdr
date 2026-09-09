import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { VoiceCard, dayOf, subjectOf, wordCount } from "@/components/settings/VoiceCard";
import { settingsCopy, voiceCopy } from "@/lib/copy/settings";
import {
  FIXTURE_PROFILE,
  MAX_SAMPLES,
  addSample,
  getProfile,
  resetProfile,
  saveProfile,
} from "@/lib/fixtures/repProfile";
import { checkVoiceNote, checkVoiceSample, countLines, tooManyLines } from "@/lib/settings/validate";

/**
 * The Your voice card (master doc §23.1f): the pasted emails as a collapsible
 * list with Add and Remove, the ten-line note, and the promise. Every change
 * goes through the adapter and the card shows what comes back.
 */

beforeEach(() => {
  resetProfile();
});

const rows = () => screen.getAllByTestId("voice-sample");
const status = () => screen.getByRole("status");
const note = () => screen.getByRole("textbox", { name: voiceCopy.noteLabel }) as HTMLTextAreaElement;
const addButton = () => screen.getByRole("button", { name: voiceCopy.add });
const removeButtons = () => screen.getAllByRole("button", { name: new RegExp(`^${voiceCopy.remove}:`) });

/** Ten emails in the adapter, for the cap. */
function fillToTen() {
  let profile = getProfile();
  while (profile.voiceSamples.length < MAX_SAMPLES) {
    profile = addSample(`Email ${profile.voiceSamples.length + 1}\n\nOne line.`, "2026-09-08");
  }
}

describe("the Your voice card", () => {
  it("renders the fixture: the count, three rows, the fold, the note and the promise", () => {
    render(<VoiceCard />);

    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe(settingsCopy.voice);
    expect(screen.getByText(`7 ${voiceCopy.emails}`)).toBeDefined();
    expect(rows()).toHaveLength(3);
    expect(rows()[0]?.textContent).toContain("Re: Depot phones after the Leeds opening");
    expect(screen.getByRole("button", { name: `${voiceCopy.show} 4 ${voiceCopy.more}` })).toBeDefined();
    expect(note().value).toBe(FIXTURE_PROFILE.voiceNote);
    expect(screen.getByText(voiceCopy.promise)).toBeDefined();
    expect(screen.getByText(voiceCopy.noteHint)).toBeDefined();
  });

  it("says the words and the day on every row", () => {
    render(<VoiceCard />);
    const first = FIXTURE_PROFILE.voiceSamples[0]!;
    expect(rows()[0]?.textContent).toContain(`${wordCount(first.text)} ${voiceCopy.words}`);
    expect(rows()[0]?.textContent).toContain(`${voiceCopy.added} 14 Aug`);
  });

  it("unfolds the list on one button with aria-expanded, and folds it again", () => {
    render(<VoiceCard />);
    const more = screen.getByRole("button", { name: `${voiceCopy.show} 4 ${voiceCopy.more}` });
    expect(more.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(more);
    expect(rows()).toHaveLength(7);
    const fewer = screen.getByRole("button", { name: voiceCopy.fewer });
    expect(fewer.getAttribute("aria-expanded")).toBe("true");

    fireEvent.click(fewer);
    expect(rows()).toHaveLength(3);
  });

  it("has no fold when there are three or fewer", () => {
    saveProfile({ voiceSamples: FIXTURE_PROFILE.voiceSamples.slice(0, 3) });
    render(<VoiceCard />);
    expect(rows()).toHaveLength(3);
    expect(screen.queryByRole("button", { name: new RegExp(`^${voiceCopy.show} `) })).toBeNull();
  });

  it("removes an email at once, says Removed, and the adapter agrees", () => {
    render(<VoiceCard />);
    const subject = subjectOf(FIXTURE_PROFILE.voiceSamples[1]!.text);

    fireEvent.click(screen.getByRole("button", { name: `${voiceCopy.remove}: ${subject}` }));

    expect(status().textContent).toBe(` · ${voiceCopy.removed}`);
    expect(screen.getByText(`6 ${voiceCopy.emails}`)).toBeDefined();
    expect(getProfile().voiceSamples.map((item) => item.id)).not.toContain("voice-night-line");
    // No confirm step: the row is gone and nothing asked.
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("adds a pasted email through the box, says Added, and closes the box", () => {
    render(<VoiceCard />);

    fireEvent.click(addButton());
    const box = screen.getByRole("textbox", { name: voiceCopy.addLabel });
    expect(screen.getByPlaceholderText(voiceCopy.addPlaceholder)).toBe(box);
    fireEvent.change(box, { target: { value: "A subject\n\nHi there,\n\nOne question.\n\nBen" } });
    fireEvent.click(screen.getByRole("button", { name: voiceCopy.addConfirm }));

    expect(status().textContent).toBe(` · ${voiceCopy.addedLine}`);
    expect(screen.getByText(`8 ${voiceCopy.emails}`)).toBeDefined();
    expect(screen.queryByRole("textbox", { name: voiceCopy.addLabel })).toBeNull();
    expect(getProfile().voiceSamples.at(-1)?.text).toBe("A subject\n\nHi there,\n\nOne question.\n\nBen");
  });

  it("refuses an empty box in place", () => {
    render(<VoiceCard />);

    fireEvent.click(addButton());
    fireEvent.click(screen.getByRole("button", { name: voiceCopy.addConfirm }));

    expect(status().textContent).toBe(` · ${voiceCopy.empty}`);
    expect(screen.getByRole("textbox", { name: voiceCopy.addLabel })).toBeDefined();
    expect(getProfile().voiceSamples).toHaveLength(7);
  });

  it("closes the box on Cancel and keeps nothing", () => {
    render(<VoiceCard />);

    fireEvent.click(addButton());
    fireEvent.change(screen.getByRole("textbox", { name: voiceCopy.addLabel }), { target: { value: "x" } });
    fireEvent.click(screen.getByRole("button", { name: voiceCopy.addCancel }));

    expect(screen.queryByRole("textbox", { name: voiceCopy.addLabel })).toBeNull();
    expect(getProfile().voiceSamples).toHaveLength(7);
  });

  it("hides Add at ten and says why; Remove brings it back", () => {
    fillToTen();
    render(<VoiceCard />);

    expect(screen.getByText(`10 ${voiceCopy.emails}`)).toBeDefined();
    expect(screen.queryByRole("button", { name: voiceCopy.add })).toBeNull();
    expect(screen.getByText(voiceCopy.full)).toBeDefined();

    fireEvent.click(removeButtons()[0]!);

    expect(screen.queryByText(voiceCopy.full)).toBeNull();
    expect(addButton()).toBeDefined();
  });

  it("refuses an eleventh email through the check, not only the button", () => {
    fillToTen();
    expect(checkVoiceSample("An eleventh", MAX_SAMPLES)).toEqual({ ok: false, message: voiceCopy.full });
    expect(() => addSample("An eleventh")).toThrow();
    expect(getProfile().voiceSamples).toHaveLength(10);
  });

  it("shows the empty line when there are no emails", () => {
    saveProfile({ voiceSamples: [] });
    render(<VoiceCard />);
    expect(screen.getByText(voiceCopy.none)).toBeDefined();
    expect(screen.getByText(`0 ${voiceCopy.emails}`)).toBeDefined();
    expect(screen.queryAllByTestId("voice-sample")).toHaveLength(0);
  });

  it("saves the note on blur and says Saved", () => {
    render(<VoiceCard />);

    fireEvent.change(note(), { target: { value: "Short.\nWarm." } });
    fireEvent.blur(note());

    expect(status().textContent).toBe(` · ${settingsCopy.saved}`);
    expect(getProfile().voiceNote).toBe("Short.\nWarm.");
  });

  it("refuses a note over ten lines, counts them, and keeps the text", () => {
    render(<VoiceCard />);
    const twelve = Array.from({ length: 12 }, (_, i) => `Line ${i + 1}`).join("\n");

    fireEvent.change(note(), { target: { value: twelve } });
    fireEvent.blur(note());

    expect(status().textContent).toBe(` · ${tooManyLines(12)}`);
    expect(status().textContent).toContain("12 lines");
    expect(note().value).toBe(twelve);
    expect(getProfile().voiceNote).toBe(FIXTURE_PROFILE.voiceNote);
  });

  it("does not save the note on a blur that changed nothing", () => {
    render(<VoiceCard />);
    fireEvent.blur(note());
    expect(status().textContent).toBe("");
  });

  it("keeps one primary control at most, and only while the box is open (§21)", () => {
    render(<VoiceCard />);
    const primaries = () => screen.getAllByRole("button").filter((b) => b.className.includes("bg-action"));
    expect(primaries()).toHaveLength(0);
    fireEvent.click(addButton());
    expect(primaries().map((b) => b.textContent)).toEqual([voiceCopy.addConfirm]);
  });

  it("labels every control and rings every focus", () => {
    render(<VoiceCard />);
    fireEvent.click(addButton());
    // Every button and every box has a name a screen reader can say...
    expect(screen.getAllByRole("button", { name: /\S/ })).toHaveLength(screen.getAllByRole("button").length);
    expect(screen.getAllByRole("textbox", { name: /\S/ })).toHaveLength(screen.getAllByRole("textbox").length);
    // ...and a ring when the keyboard lands on it.
    for (const control of [...screen.getAllByRole("button"), ...screen.getAllByRole("textbox")]) {
      expect(control.className, control.outerHTML).toContain("focus-visible:ring-2");
    }
  });
});

describe("the note's line count", () => {
  it("counts lines as a rep would", () => {
    expect(countLines("")).toBe(0);
    expect(countLines("one")).toBe(1);
    expect(countLines("one\ntwo")).toBe(2);
    expect(countLines("one\n\nthree")).toBe(3);
    expect(countLines("one\ntwo\n")).toBe(2);
    expect(countLines("one\r\ntwo")).toBe(2);
  });

  it("accepts ten and refuses eleven", () => {
    const ten = Array.from({ length: 10 }, () => "x").join("\n");
    expect(checkVoiceNote(ten)).toEqual({ ok: true, value: ten });
    expect(checkVoiceNote(`${ten}\nx`)).toEqual({ ok: false, message: tooManyLines(11) });
  });
});

describe("the row's words", () => {
  it("takes the first line with anything on it as the subject", () => {
    expect(subjectOf("\n  Re: hello \n\nbody")).toBe("Re: hello");
    expect(subjectOf("")).toBe("");
  });

  it("counts words and reads the day", () => {
    expect(wordCount("one two  three\n\nfour")).toBe(4);
    expect(dayOf("2026-09-02")).toBe("2 Sep");
  });
});
