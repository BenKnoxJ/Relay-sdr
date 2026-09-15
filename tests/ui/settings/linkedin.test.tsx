import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { LinkedInCard } from "@/components/settings/LinkedInCard";
import { linkedinCopy, settingsCopy } from "@/lib/copy/settings";
import { FIXTURE_PROFILE, getProfile, resetProfile, saveProfile } from "@/lib/fixtures/repProfile";
import { checkLinkedinUrl } from "@/lib/settings/validate";

/**
 * The LinkedIn card (master doc §23.1f): an empty field with the shape of a
 * link as its placeholder, the one line about posting, save on blur with
 * "Saved", and a plain refusal of anything that is not a profile link.
 */

beforeEach(() => {
  resetProfile();
});

const field = () => screen.getByRole("textbox", { name: linkedinCopy.profileLabel }) as HTMLInputElement;
const status = () => screen.getByRole("status");

describe("the LinkedIn card", () => {
  it("renders an empty field with the shape of a link as its placeholder, and the line about posting", () => {
    render(<LinkedInCard />);

    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe(settingsCopy.linkedin);
    expect(FIXTURE_PROFILE.linkedinUrl).toBeNull();
    expect(field().value).toBe("");
    expect(field().placeholder).toBe(linkedinCopy.placeholder);
    expect(linkedinCopy.placeholder).toBe("https://www.linkedin.com/in/…");
    expect(screen.getByText(linkedinCopy.note)).toBeDefined();
    // Prepare-and-paste in slice 1: no connect, no disconnect, no button at all.
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });

  it("is a full-width field that can shrink and wrap under its label on a phone", () => {
    render(<LinkedInCard />);

    for (const cls of ["w-full", "min-w-0", "flex-1"]) expect(field().className).toContain(cls);
    expect(field().parentElement?.className).toContain("flex-wrap");
  });

  it("saves a good link on blur, says Saved, and the adapter has it", () => {
    render(<LinkedInCard />);

    fireEvent.change(field(), { target: { value: "https://linkedin.com/in/ben-kj/" } });
    expect(status().textContent).toBe("");
    fireEvent.blur(field());

    expect(status().textContent).toBe(settingsCopy.saved);
    expect(getProfile().linkedinUrl).toBe("https://linkedin.com/in/ben-kj/");
  });

  it("refuses a link that is not a profile link, in plain words, and keeps what was typed", () => {
    saveProfile({ linkedinUrl: "https://www.linkedin.com/in/someone" });
    render(<LinkedInCard />);

    fireEvent.change(field(), { target: { value: "https://www.linkedin.com/company/relay" } });
    fireEvent.blur(field());

    expect(status().textContent).toBe(linkedinCopy.badUrl);
    expect(field().value).toBe("https://www.linkedin.com/company/relay");
    expect(getProfile().linkedinUrl).toBe("https://www.linkedin.com/in/someone");
  });

  it("clears the link when the field is emptied", () => {
    saveProfile({ linkedinUrl: "https://www.linkedin.com/in/someone" });
    render(<LinkedInCard />);

    fireEvent.change(field(), { target: { value: "" } });
    fireEvent.blur(field());

    expect(status().textContent).toBe(settingsCopy.saved);
    expect(getProfile().linkedinUrl).toBeNull();
  });

  it("does not save on a blur that changed nothing", () => {
    render(<LinkedInCard />);

    fireEvent.blur(field());

    expect(status().textContent).toBe("");
  });

  it("has a focus ring on the field", () => {
    render(<LinkedInCard />);
    expect(field().className).toContain("focus-visible:ring-2");
  });
});

describe("checkLinkedinUrl", () => {
  it.each([
    "https://www.linkedin.com/in/benknoxjohnston",
    "https://linkedin.com/in/ben-kj",
    "https://www.linkedin.com/in/ben_kj/",
    "  https://www.linkedin.com/in/ben%20kj  ",
  ])("accepts %s", (url) => {
    expect(checkLinkedinUrl(url)).toEqual({ ok: true, value: url.trim() });
  });

  it.each([
    "http://www.linkedin.com/in/ben",
    "https://www.linkedin.com/company/relay",
    "https://www.linkedin.com/in/",
    "https://www.linkedin.com/in/ben/detail",
    "https://example.com/in/ben",
    "linkedin.com/in/ben",
    "ben",
  ])("refuses %s with the plain line", (url) => {
    expect(checkLinkedinUrl(url)).toEqual({ ok: false, message: linkedinCopy.badUrl });
  });

  it("reads an empty field as no link, not a bad one", () => {
    expect(checkLinkedinUrl("   ")).toEqual({ ok: true, value: null });
  });
});
