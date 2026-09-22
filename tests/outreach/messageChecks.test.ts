import { describe, expect, it } from "vitest";

import {
  changePct,
  genderedPronouns,
  hasAttributedInsight,
  isBinaryAsk,
  measure,
  mentionsPrice,
  mentionsProduct,
  parseCohortMarkdown,
  renderChecks,
  renderComparison,
  stockOpener,
  type CheckedTouch,
} from "@/lib/outreach/messageChecks";

/** Messaging v2: the cohort report's measures against the writing standard. */

const touch = (kind: string, body: string, patch: Partial<CheckedTouch> = {}): CheckedTouch => ({ kind, body, ask: body.match(/[^.?!]*\?\s*$/)?.[0]?.trim() ?? "", claims: [], ...patch });

describe("the humanizer's change size", () => {
  it("is the share of characters changed, from 0 for untouched to 100 for nothing in common", () => {
    expect(changePct("same words", "same words")).toBe(0);
    expect(changePct("abcd", "wxyz")).toBe(100);
    expect(changePct("", "")).toBe(0);
    // One character in ten.
    expect(changePct("abcdefghij", "abcdefghiX")).toBe(10);
    expect(changePct("Is that a gap for you?", "Is that something you look at?")).toBeGreaterThan(30);
  });
});

describe("the standard's measures", () => {
  it("finds the product named, described in a product sentence, or cited", () => {
    expect(mentionsProduct(touch("email1", "Insights360 reads every call. How do you find them?"), "Insights360")).toBe(true);
    expect(mentionsProduct(touch("email1", "We score every call against your rules. How do you find them?"), "Insights360")).toBe(true);
    expect(mentionsProduct(touch("email1", "Every call that comes in is transcribed. How?"), "Insights360")).toBe(true);
    expect(mentionsProduct(touch("email1", "Delay calls are hard to find. How do you find them?", { claims: ["i360.feature.x"] }), "Insights360")).toBe(true);
    expect(mentionsProduct(touch("email1", "You told the conference delay was the biggest theme. How do you find those calls?"), "Insights360")).toBe(false);
  });

  it("finds a price, a fee or a contract term, or a cited price fact", () => {
    expect(mentionsPrice(touch("li_dm2", "Plans run month to month with no seat minimum. Worth a look?"))).toBe(true);
    expect(mentionsPrice(touch("email2", "It starts at £4.99 a seat. Worth a look?"))).toBe(true);
    expect(mentionsPrice(touch("email2", "Worth a look?", { claims: ["i360.price.per-seat-plans"] }))).toBe(true);
    expect(mentionsPrice(touch("email2", "The cost of a complaint is the calls behind it. Who owns that?"))).toBe(false);
  });

  it("finds an \"X, or Y?\" ask and nothing else", () => {
    expect(isBinaryAsk("Is that something you can already do, or still missing for you?")).toBe(true);
    expect(isBinaryAsk("Worth a look or not?")).toBe(true);
    expect(isBinaryAsk("How do your team leaders choose which calls to review?")).toBe(false);
    expect(isBinaryAsk("If claims QA or complaint handling sits with someone else, who would that be?")).toBe(false);
  });

  it("finds a stock opener or subject, on a message or a call script", () => {
    expect(stockOpener(touch("li_dm", "Thanks for connecting. In motor claims, delay drives most complaints. Do you see that?"))).toBe('opener "Thanks for connecting"');
    expect(stockOpener(touch("li_dm2", "One more thought: plans are flexible. Worth a look?"))).toBe('opener "One more thought"');
    expect(stockOpener(touch("breakup", "I'll leave it here. Who would be right?", { subject: "one last note" }))).toBe('subject "one last note"');
    expect(stockOpener(touch("call", "Open with: Hi, just following up on my email.\n\nAsk: How?"))).toMatch(/following up/);
    expect(stockOpener(touch("breakup", "I'll leave it here. Who would be right?", { subject: "delay calls at Ardent" }))).toBeNull();
  });

  it("finds a gendered pronoun, whole words only", () => {
    expect(genderedPronouns(touch("call", "Listen for whether he owns it, and her team."))).toEqual(["he", "her"]);
    expect(genderedPronouns(touch("call", "Listen for whether they own it; the theme, the head, the shed."))).toEqual([]);
  });

  it("finds an attributed insight: a named source and what it found, or the reader's own public words", () => {
    expect(hasAttributedInsight(touch("email1", "The ombudsman's figures show complaints rose to 4,100. How?"))).toBe(true);
    expect(hasAttributedInsight(touch("email1", "When the FCA reviewed 40 firms, it found they did not always measure impact. Useful?"))).toBe(true);
    expect(hasAttributedInsight(touch("email1", "You told the conference that delay was the biggest theme. How?"))).toBe(true);
    expect(hasAttributedInsight(touch("email1", "Team leaders coach from the calls they happen to catch. Does that match?"))).toBe(false);
  });
});

const EARLIER = [
  "# Relay Outreach: full-sequence cohort",
  "",
  "## Summary per touch kind (after the humanizer)",
  "",
  "## Ada Lane · Head of Claims, Acme · role: runs",
  "",
  "### Email 1 · **to_review** · generations: 1 · kept: humanized",
  "",
  "**Drafted:**",
  "",
  "```",
  "Subject: calls behind complaints",
  "",
  "Complaints come from calls. We score every call that comes in. Is that covered, or still missing for you?",
  "```",
  "",
  "**Humanized:**",
  "",
  "```",
  "Subject: calls behind complaints",
  "",
  "Complaints start on calls. We score every call that comes in. Is that covered, or still missing for you?",
  "```",
  "",
  '**Stored (what the rep sees):** subject "calls behind complaints"; ask "Is that covered, or still missing for you?"  ',
  '**Opener:** `{"ref":"x","kind":"role_pain"}` · **Claims:** `["i360.product.every-ingested-call-analysed"]`  ',
  "",
  "### LinkedIn message · **to_review** · generations: 1 · kept: drafted",
  "",
  "**Drafted:**",
  "",
  "```",
  "Thanks for connecting. His team hears a sample. Is that right?",
  "```",
  "",
  "**Humanized:**",
  "",
  "```",
  "Thanks for connecting. The team hears a sample. Is that right?",
  "```",
  "",
  '**Stored (what the rep sees):** ask "Is that right?"  ',
  "**Opener:** `{}` · **Claims:** `[]`  ",
  "",
  "### Email 3 (last email) · **failed** · generations: 2",
  "",
  "**Drafted:**",
  "",
  "```",
  "(not written)",
  "```",
  "",
].join("\n");

describe("an earlier cohort report, read back", () => {
  it("reads each person's written touches: the kept text, the ask, the claims and the humanizer's change", () => {
    const [ada] = parseCohortMarkdown(EARLIER);
    expect(ada!.name).toBe("Ada Lane");
    expect(ada!.touches.map((entry) => entry.kind)).toEqual(["email1", "li_dm"]);
    expect(ada!.touches[0]).toMatchObject({ subject: "calls behind complaints", ask: "Is that covered, or still missing for you?", claims: ["i360.product.every-ingested-call-analysed"] });
    expect(ada!.touches[0]!.body).toMatch(/^Complaints start on calls\./);
    // Kept as drafted: the rep saw the draft, pronoun and all.
    expect(ada!.touches[1]!.body).toMatch(/His team/);
    expect(ada!.touches[1]!.changePct).toBeGreaterThan(0);
  });

  it("measures it and renders the comparison and the checks", () => {
    const before = parseCohortMarkdown(EARLIER);
    expect(measure(before, "Insights360")).toMatchObject({ productInEmail1: 1, binaryAsks: 1, stockOpeners: 1, genderedTouches: 1, people: 1, touches: 2 });
    const now = [{ name: "Ada Lane", touches: [touch("email1", "You told the conference delay was the biggest theme. How do you find the calls?", { changePct: 12 })] }];
    const comparison = renderComparison(before, now, "Insights360", "21 Sep");
    expect(comparison).toContain("| Product in Email 1 | 1 of 1 | 0 of 1 |");
    expect(comparison).toContain("| Touches with a gendered pronoun | 1 | 0 |");
    const checks = renderChecks(now, "Insights360");
    expect(checks).toContain("| Product lines in Email 1 | 0 | 0 of 1 | yes |");
    expect(checks).toContain("| Humanizer change, median | at least 10% | 12.0% over 1 touches | yes |");
  });
});
