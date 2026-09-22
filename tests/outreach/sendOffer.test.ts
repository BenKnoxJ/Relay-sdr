import { describe, expect, it } from "vitest";

import { SEND_DAILY_CAP, sendOffer, type SendFacts } from "@/lib/outreach/send";

/** The Send button's rule, which is also the server's check (Relay P7). */

const base: SendFacts = {
  step: { id: "email1", due: "2026-10-05", nextActions: ["sent"] },
  draftState: "approved",
  paused: false,
  mailbox: true,
  sentToday: 0,
  row: null,
  threadReady: false,
  today: "2026-10-05",
};
const offer = (facts: Partial<SendFacts>) => sendOffer({ ...base, ...facts });

describe("sendOffer", () => {
  it("offers Send on an approved email due today or overdue", () => {
    expect(offer({})).toEqual({ kind: "send" });
    expect(offer({ today: "2026-10-09" })).toEqual({ kind: "send" });
  });

  it("says from when before it is due", () => {
    expect(offer({ today: "2026-10-02" })).toEqual({ kind: "not_due", from: "2026-10-05" });
  });

  it("offers nothing that is not an approved, open email step", () => {
    expect(offer({ step: { id: "li_connect", due: "2026-10-05", nextActions: ["sent"] } })).toEqual({ kind: "none" });
    expect(offer({ draftState: "to_review" })).toEqual({ kind: "none" });
    expect(offer({ draftState: null })).toEqual({ kind: "none" });
    expect(offer({ step: { id: "email1", due: "2026-10-05", nextActions: ["replied", "bounced"] } })).toEqual({ kind: "none" });
    expect(offer({ step: { id: "email2", due: "2026-10-12", nextActions: [] }, threadReady: true, today: "2026-10-12" })).toEqual({ kind: "none" });
    expect(offer({ row: { state: "sent", stale: false } })).toEqual({ kind: "none" });
  });

  it("puts paused, then the mailbox, ahead of the date", () => {
    expect(offer({ paused: true, mailbox: false, today: "2026-10-01" })).toEqual({ kind: "paused" });
    expect(offer({ mailbox: false, today: "2026-10-01" })).toEqual({ kind: "no_mailbox" });
  });

  it("needs Email 1's thread for a follow-up", () => {
    const email2 = { step: { id: "email2" as const, due: "2026-10-12", nextActions: ["sent" as const] }, today: "2026-10-12" };
    expect(offer(email2)).toEqual({ kind: "by_hand" });
    expect(offer({ ...email2, threadReady: true })).toEqual({ kind: "send" });
  });

  it(`stops at ${SEND_DAILY_CAP} a day`, () => {
    expect(offer({ sentToday: SEND_DAILY_CAP - 1 })).toEqual({ kind: "send" });
    expect(offer({ sentToday: SEND_DAILY_CAP })).toEqual({ kind: "cap", cap: SEND_DAILY_CAP });
  });

  it("reports a send under way, checks one that may have gone, and offers a failed one again", () => {
    expect(offer({ row: { state: "sending", stale: false } })).toEqual({ kind: "sending" });
    expect(offer({ row: { state: "sending", stale: true } })).toEqual({ kind: "unverified" });
    expect(offer({ row: { state: "unverified", stale: false }, paused: true })).toEqual({ kind: "unverified" });
    expect(offer({ row: { state: "unverified", stale: false }, mailbox: false })).toEqual({ kind: "no_mailbox" });
    expect(offer({ row: { state: "failed", stale: false } })).toEqual({ kind: "send" });
    expect(offer({ row: { state: "failed", stale: false }, paused: true })).toEqual({ kind: "paused" });
  });
});
