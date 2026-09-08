import { describe, expect, it } from "vitest";

import { dateLabel, firstNameFor, initialsFor } from "@/lib/shell";

/**
 * The three small decisions the shell makes about a person and a date. Every
 * case below is an account shape that actually occurs: Clerk lets every part
 * of a name be empty, and the local `DEV_USER_EMAIL` bypass supplies none.
 */

describe("firstNameFor", () => {
  it("greets a rep by their first name", () => {
    expect(firstNameFor("Ben Knox-Johnston", "ben@example.test")).toBe("Ben");
    expect(firstNameFor("Ben", "ben@example.test")).toBe("Ben");
  });

  it("falls back to the address when there is no name, written as a name", () => {
    // The local development bypass supplies no name at all, so this is the
    // greeting a developer actually sees. "Welcome, ben" reads as a bug.
    expect(firstNameFor(null, "ben@example.test")).toBe("Ben");
    expect(firstNameFor("   ", "ben@example.test")).toBe("Ben");
  });

  it("takes the first name out of a first.last address", () => {
    // The shape most corporate addresses take, and the one the bypass hits.
    for (const local of ["ben.knox-johnston", "ben_knox", "ben+relay", "ben-knox"]) {
      expect(firstNameFor(null, `${local}@example.test`), local).toBe("Ben");
    }
  });

  it("writes a name the person gave exactly as they gave it", () => {
    expect(firstNameFor("ben", "someone@example.test")).toBe("ben");
    expect(firstNameFor("McTavish Ross", "someone@example.test")).toBe("McTavish");
  });

  it("never greets nobody", () => {
    expect(firstNameFor(null, "ben")).toBe("Ben");
    expect(firstNameFor(null, "@example.test")).toBe("@example.test");
  });
});

describe("initialsFor", () => {
  it("takes the first and last initial", () => {
    expect(initialsFor("Ben Knox-Johnston", "ben@example.test")).toBe("BK");
    // A middle name must not push the surname out of the circle.
    expect(initialsFor("Ben Michael Knox", "ben@example.test")).toBe("BK");
  });

  it("takes two letters from a single name", () => {
    expect(initialsFor("Ben", "ben@example.test")).toBe("BE");
  });

  it("falls back to the address, and is never empty", () => {
    expect(initialsFor(null, "ben@example.test")).toBe("BE");
    expect(initialsFor("  ", "ben@example.test")).toBe("BE");
  });

  /**
   * The case a real account produces. Corporate addresses are `first.last`,
   * and the two letters of a `first.last` address are the two NAMES in it —
   * "ben.knox-johnston" is BK, not BE. `firstNameFor` already reads the
   * address this way; the circle beside it read the first two characters and
   * so disagreed with the greeting on the same screen.
   */
  it("reads a first.last address as two names, not two letters", () => {
    expect(initialsFor(null, "ben.knox-johnston@example.test")).toBe("BK");
    expect(initialsFor(null, "ben_knox@example.test")).toBe("BK");
    expect(initialsFor(null, "ben-knox@example.test")).toBe("BK");
    expect(initialsFor(null, "ben+knox@example.test")).toBe("BK");
  });

  /** A name Clerk supplied always wins over anything read out of the address. */
  it("prefers the name over the address when there is one", () => {
    expect(initialsFor("Sam Okafor", "ben.knox-johnston@example.test")).toBe("SO");
  });

  /** A separator with nothing after it is not a second name. */
  it("takes two letters when the address has no second segment", () => {
    expect(initialsFor(null, "ben.@example.test")).toBe("BE");
    expect(initialsFor(null, "b@example.test")).toBe("B");
  });
});

describe("dateLabel", () => {
  it("reads as the signed mock has it", () => {
    expect(dateLabel(new Date("2026-09-07T09:00:00Z"))).toBe("Mon 7 Sep");
  });

  /**
   * The one that matters. At 23:30 in London the machine's UTC clock is
   * already tomorrow in half the year, so a date formatted in the server's
   * zone tells a rep it is Tuesday while they are still working Monday.
   */
  it("keeps the pilot's clock, not the server's", () => {
    // 00:30 UTC on the 8th is 01:30 on the 8th in British Summer Time.
    expect(dateLabel(new Date("2026-09-08T00:30:00Z"))).toBe("Tue 8 Sep");
    // 23:30 UTC on the 7th is 00:30 on the 8th in London: still the 8th.
    expect(dateLabel(new Date("2026-09-07T23:30:00Z"))).toBe("Tue 8 Sep");
    // And in winter, when London is UTC, the two agree again.
    expect(dateLabel(new Date("2026-01-05T23:30:00Z"))).toBe("Mon 5 Jan");
  });
});
