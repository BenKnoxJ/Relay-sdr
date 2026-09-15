import { describe, expect, it } from "vitest";

import { activityEntriesOf, activityLineOf, whenLabel } from "@/lib/campaigns/activity";
import { campaignsCopy } from "@/lib/copy/campaigns";

/**
 * Activity, in a rep's words (final MVP pass): every stored kind gets a line
 * a rep can read, a kind Relay has no words for is left out rather than shown
 * as a machine word, and nothing is a count of work that has not happened.
 */
const AT = new Date("2026-09-14T11:05:00Z");
const row = (kind: string, projection: unknown = {}, actorName: string | null = "Ben Knox Johnston") => ({ id: `e-${kind}`, kind, at: AT, actorName, projection });

describe("activity lines", () => {
  it("says what happened for every kind Relay records, in copy words only", () => {
    const c = campaignsCopy;
    expect(activityLineOf(row("campaign.created"))?.line).toBe(c.activityCreated);
    expect(activityLineOf(row("campaign.brief_changed", { cause: "edit", briefVersion: 2 }))?.line).toBe(`${c.activityBriefEdited} (${c.activityVersion} 2)`);
    expect(activityLineOf(row("campaign.brief_changed", { cause: "widening", briefVersion: 3 }))?.line).toBe(`${c.activityBriefWidened} (${c.activityVersion} 3)`);
    expect(activityLineOf(row("research.completed", { outcome: "complete", partial: false }))?.line).toBe(c.activityResearchDone);
    expect(activityLineOf(row("research.completed", { outcome: "partial", partial: true }))?.line).toBe(c.activityResearchPartial);
    expect(activityLineOf(row("research.completed", { outcome: "insufficient" }))?.line).toBe(c.activityResearchStopped);
    const confirmed = activityLineOf(row("campaign.confirmed", { groupName: "Claims teams", selection: "chosen", cap: 40, lawfulBasis: c.lawfulBasis }));
    expect(confirmed?.line).toBe(`${c.activityConfirmed} Claims teams${c.noteJoin}${c.activityConfirmedChosen}${c.noteJoin}${c.activityLimit} 40 ${c.spendCreditsWord}`);
    expect(confirmed?.detail).toBe(`${c.activityLawful}: ${c.lawfulBasis}`);
    expect(activityLineOf(row("leadgen.picked", { n: 9, ofM: 20 }))?.line).toBe(`${c.activityFound} 9 ${c.accountPeople} ${c.peopleFoundOf} 20 ${c.activityFoundAsked}`);
    expect(activityLineOf(row("leadgen.halted", { reason: "provider_busy" }))?.line).toBe(`${c.activityHalted} ${c.haltBusy}`);
    expect(activityLineOf(row("leadgen.rerun", { cause: "choice" }))?.line).toBe(c.activitySearchedWithChoice);
    expect(activityLineOf(row("campaign.people_reviewed", { scope: "account", decision: "dropped", count: 2 }))?.line).toBe(`${c.activityDropped} 2 ${c.accountPeople} ${c.activityAccount}`);
    expect(activityLineOf(row("campaign.people_reviewed", { scope: "person", decision: "kept", count: 1 }))?.line).toBe(`${c.activityKept} 1 ${c.accountPerson}`);
    expect(activityLineOf(row("campaign.reveal_confirmed", { toReveal: 4, known: 1, maxCredits: 4 }))?.line).toBe(`${c.activityRevealConfirmed} 4 ${c.activityRevealEmails} 4 ${c.spendCreditsWord}`);
    expect(activityLineOf(row("leadgen.revealed", { tally: { revealed: 3, known: 1, no_email: 1, suppressed: 0, held: 0, failed: 0 } }))?.line).toBe(
      `${c.activityRevealed} 3 emails${c.noteJoin}1 ${c.activityRevealedKnown}${c.noteJoin}1 ${c.activityRevealedWithout}`,
    );
    expect(activityLineOf(row("campaign.reveal_retried"))?.line).toBe(c.activityRevealRetried);
  });

  it("leaves out what it has no words for: an unknown kind, a review that changed nobody", () => {
    expect(activityLineOf(row("draft.ready"))).toBeNull();
    expect(activityLineOf(row("campaign.people_reviewed", { scope: "person", decision: "kept", count: 0 }))).toBeNull();
    expect(activityEntriesOf([row("draft.ready"), row("campaign.created")])).toHaveLength(1);
  });

  it("carries when and who, newest first as given, with a first name and never an email", () => {
    const [entry] = activityEntriesOf([row("campaign.created", {}, "Ben Knox Johnston")]);
    expect(entry).toMatchObject({ id: "e-campaign.created", at: AT.toISOString(), by: "Ben", line: campaignsCopy.activityCreated, detail: null });
    expect(entry?.when).toBe(whenLabel(AT));
    expect(whenLabel(AT)).toBe("14 Sep, 12:05");
    expect(activityEntriesOf([row("research.completed", { outcome: "complete" }, null)])[0]?.by).toBeNull();
  });
});
