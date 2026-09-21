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
 * list with Remove, the ten-line note, and the promise. Every change goes
 * through the adapter and the card shows what comes back.
 *
 * The fixture is empty, so the page opens on the empty line and nothing
 * invented. Add saves through the adapter, or live through `onPersist`; the
 * list and the fold are checked by putting emails into the adapter directly,
 * which is the seam a repository replaces.
 */

beforeEach(() => {
  resetProfile();
});

const rows = () => screen.getAllByTestId("voice-sample");
const status = () => screen.getByRole("status");
const note = () => screen.getByRole("textbox", { name: voiceCopy.noteLabel }) as HTMLTextAreaElement;
const addButton = () => screen.getByRole("button", { name: voiceCopy.add });
const removeButtons = () => screen.getAllByRole("button", { name: new RegExp(`^${voiceCopy.remove}:`) });

/** `n` emails in the adapter, subject first, each on a day of its own. */
function fill(n: number) {
  let profile = getProfile();
  while (profile.voiceSamples.length < n) {
    const i = profile.voiceSamples.length + 1;
    profile = addSample(`Subject ${i}\n\nOne line, and a second one.`, `2026-08-${String(10 + i).padStart(2, "0")}`);
  }
}

describe("the Your voice card", () => {
  it("opens empty: the line, no rows, no count, the note with its placeholder and the promise", () => {
    render(<VoiceCard />);

    expect(FIXTURE_PROFILE.voiceSamples).toEqual([]);
    expect(FIXTURE_PROFILE.voiceNote).toBe("");
    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe(settingsCopy.voice);
    expect(screen.getByText(voiceCopy.none)).toBeDefined();
    expect(voiceCopy.none).toBe(
      "Paste 5 to 10 emails you are proud of. Relay uses them as examples in every draft and never sends them.",
    );
    expect(screen.queryAllByTestId("voice-sample")).toHaveLength(0);
    expect(screen.queryByText(new RegExp(`^\\d+ ${voiceCopy.emails}$`))).toBeNull();
    expect(note().value).toBe("");
    expect(note().placeholder).toBe(voiceCopy.notePlaceholder);
    expect(screen.getByText(voiceCopy.promise)).toBeDefined();
    expect(screen.getByText(voiceCopy.noteHint)).toBeDefined();
  });

  it("opens Add's box, and adds the email to the adapter with Added on the line", () => {
    render(<VoiceCard />);

    expect(addButton().hasAttribute("disabled")).toBe(false);
    expect(screen.queryByText("Saving your voice arrives with outreach.")).toBeNull();
    fireEvent.click(addButton());
    const box = screen.getByRole("textbox", { name: voiceCopy.addLabel });
    fireEvent.change(box, { target: { value: "Subject 1\n\nA short email I was proud of." } });
    fireEvent.click(screen.getByRole("button", { name: voiceCopy.addConfirm }));

    expect(getProfile().voiceSamples).toHaveLength(1);
    expect(rows()).toHaveLength(1);
    expect(status().textContent).toContain(voiceCopy.addedLine);
    expect(screen.queryByRole("textbox", { name: voiceCopy.addLabel })).toBeNull();
  });

  it("saves an added email live through onPersist, with the samples already there", async () => {
    const saved: { samples: { text: string; addedAt: string }[]; howIWrite: string }[] = [];
    const onPersist = async (voice: (typeof saved)[number]) => {
      saved.push(voice);
      return null;
    };
    render(<VoiceCard initial={{ ...getProfile(), voiceSamples: [{ id: "v1", text: "Earlier email", addedAt: "2026-09-01" }], voiceNote: "Short." }} onPersist={onPersist} />);

    fireEvent.click(addButton());
    fireEvent.change(screen.getByRole("textbox", { name: voiceCopy.addLabel }), { target: { value: "A new one." } });
    fireEvent.click(screen.getByRole("button", { name: voiceCopy.addConfirm }));

    expect(saved).toHaveLength(1);
    expect(saved[0]!.samples.map((sample) => sample.text)).toEqual(["Earlier email", "A new one."]);
    expect(saved[0]!.howIWrite).toBe("Short.");
    expect(rows()).toHaveLength(2);
  });

  it("shows the emails the adapter holds: the count, three rows and the fold", () => {
    fill(7);
    render(<VoiceCard />);

    expect(screen.getByText(`7 ${voiceCopy.emails}`)).toBeDefined();
    expect(rows()).toHaveLength(3);
    expect(rows()[0]?.textContent).toContain("Subject 1");
    expect(screen.getByRole("button", { name: `${voiceCopy.show} 4 ${voiceCopy.more}` })).toBeDefined();
    expect(screen.queryByText(voiceCopy.none)).toBeNull();
  });

  it("says the words and the day on every row", () => {
    fill(1);
    render(<VoiceCard />);
    const first = getProfile().voiceSamples[0]!;
    expect(screen.getByText(`1 ${voiceCopy.email}`)).toBeDefined();
    expect(rows()[0]?.textContent).toContain(`${wordCount(first.text)} ${voiceCopy.words}`);
    expect(rows()[0]?.textContent).toContain(`${voiceCopy.added} 11 Aug`);
  });

  it("unfolds the list on one button with aria-expanded, and folds it again", () => {
    fill(7);
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
    fill(3);
    render(<VoiceCard />);
    expect(rows()).toHaveLength(3);
    expect(screen.queryByRole("button", { name: new RegExp(`^${voiceCopy.show} `) })).toBeNull();
  });

  it("removes an email at once, says Removed, and the adapter agrees", () => {
    fill(2);
    const second = getProfile().voiceSamples[1]!;
    render(<VoiceCard />);

    fireEvent.click(screen.getByRole("button", { name: `${voiceCopy.remove}: ${subjectOf(second.text)}` }));

    expect(status().textContent).toBe(` · ${voiceCopy.removed}`);
    expect(screen.getByText(`1 ${voiceCopy.emails}`.replace(voiceCopy.emails, voiceCopy.email))).toBeDefined();
    expect(getProfile().voiceSamples.map((item) => item.id)).not.toContain(second.id);
    // No confirm step: the row is gone and nothing asked.
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("says why at ten, and Remove brings the Add control back", () => {
    fill(MAX_SAMPLES);
    render(<VoiceCard />);

    expect(screen.getByText(`10 ${voiceCopy.emails}`)).toBeDefined();
    expect(screen.queryByRole("button", { name: voiceCopy.add })).toBeNull();
    expect(screen.getByText(voiceCopy.full)).toBeDefined();

    fireEvent.click(removeButtons()[0]!);

    expect(screen.queryByText(voiceCopy.full)).toBeNull();
    expect(addButton()).toBeDefined();
  });

  it("refuses an eleventh email through the check and the adapter alike", () => {
    fill(MAX_SAMPLES);
    expect(checkVoiceSample("An eleventh", MAX_SAMPLES)).toEqual({ ok: false, message: voiceCopy.full });
    expect(() => addSample("An eleventh")).toThrow();
    expect(getProfile().voiceSamples).toHaveLength(10);
  });

  it("refuses an empty paste through the check", () => {
    expect(checkVoiceSample("   ", 0)).toEqual({ ok: false, message: voiceCopy.empty });
  });

  it("saves the note on blur and says Saved", () => {
    render(<VoiceCard />);

    fireEvent.change(note(), { target: { value: "Short.\nWarm." } });
    fireEvent.blur(note());

    expect(status().textContent).toBe(settingsCopy.saved);
    expect(getProfile().voiceNote).toBe("Short.\nWarm.");
  });

  it("refuses a note over ten lines, counts them, and keeps the text", () => {
    saveProfile({ voiceNote: "Short." });
    render(<VoiceCard />);
    const twelve = Array.from({ length: 12 }, (_, i) => `Line ${i + 1}`).join("\n");

    fireEvent.change(note(), { target: { value: twelve } });
    fireEvent.blur(note());

    expect(status().textContent).toBe(tooManyLines(12));
    expect(status().textContent).toContain("12 lines");
    expect(note().value).toBe(twelve);
    expect(getProfile().voiceNote).toBe("Short.");
  });

  it("does not save the note on a blur that changed nothing", () => {
    render(<VoiceCard />);
    fireEvent.blur(note());
    expect(status().textContent).toBe("");
  });

  it("has no primary control while Add is off (§21)", () => {
    render(<VoiceCard />);
    const primaries = screen.getAllByRole("button").filter((b) => b.className.includes("bg-action"));
    expect(primaries).toHaveLength(0);
  });

  it("labels every control and rings every focus", () => {
    fill(4);
    render(<VoiceCard />);
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
