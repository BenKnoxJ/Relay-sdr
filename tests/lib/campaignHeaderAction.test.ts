import { describe, expect, it } from "vitest";

import { headerActionOf } from "@/lib/campaigns/headerAction";
import type { CampaignNextAction, CampaignStage, ResearchActions } from "@/lib/campaigns/types";
import { campaignsCopy } from "@/lib/copy/campaigns";

/**
 * The header's one control follows the backend's `nextAction` (final MVP
 * pass): every value it can take is mapped, Edit brief included, and a
 * choice that lives in the main card draws no button.
 */
const NONE: ResearchActions = { widen: false, edit: true, retry: false };
const ALL = { confirm: true, retry: true, retryPeople: true, retryReveal: true, reveal: true, write: true };
const at = (stage: CampaignStage, nextAction: CampaignNextAction | null, can: ResearchActions = NONE, handlers = ALL, editHref: string | null = "/campaigns/c/edit") =>
  headerActionOf({ stage, nextAction }, can, handlers, { ...(editHref === null ? {} : { editHref }), revealBlocked: campaignsCopy.revealKeepFirst });

describe("headerActionOf", () => {
  it("maps every next action to one control, and Edit brief to a link", () => {
    expect(at("plan_ready", "confirm", { ...NONE, confirm: true })).toEqual({ kind: "confirm", label: campaignsCopy.actionConfirm, note: campaignsCopy.confirmNote });
    expect(at("research_needs_you", "retry_research", { ...NONE, retry: true })).toEqual({ kind: "retry", label: campaignsCopy.actionTryAgain });
    expect(at("people_needs_you", "retry_people", { ...NONE, retryPeople: true })).toEqual({ kind: "retryPeople", label: campaignsCopy.actionTryAgain });
    expect(at("reveal_needs_you", "retry_reveal", { ...NONE, retryReveal: true })).toEqual({ kind: "retryReveal", label: campaignsCopy.actionTryAgain });
    expect(at("research_needs_you", "edit_brief")).toEqual({ kind: "editBrief", label: campaignsCopy.editBrief, href: "/campaigns/c/edit" });
    expect(at("reveal_needs_you", "edit_brief")).toEqual({ kind: "editBrief", label: campaignsCopy.editBrief, href: "/campaigns/c/edit" });
    expect(at("reviewing_people", "review_people", { ...NONE, reveal: true })).toEqual({ kind: "reveal", label: campaignsCopy.actionReveal, note: campaignsCopy.revealNote });
  });

  it("draws Confirm and Reveal disabled, with the reason, where the server does not allow them yet", () => {
    expect(at("plan_ready", null)).toEqual({ kind: "confirm", label: campaignsCopy.actionConfirm, disabled: true, note: campaignsCopy.confirmLater });
    expect(at("reviewing_people", "review_people")).toEqual({ kind: "reveal", label: campaignsCopy.actionReveal, disabled: true, note: campaignsCopy.revealKeepFirst });
    expect(at("people_ready", null)).toEqual({ kind: "outreach", label: campaignsCopy.actionWriteEmails, disabled: true, note: campaignsCopy.outreachLater });
    expect(at("people_ready", "write_emails", { ...NONE, write: true })).toEqual({ kind: "write", label: campaignsCopy.actionWriteEmailsLive, note: campaignsCopy.writeNote });
    expect(at("people_ready", "write_emails", { ...NONE, write: true }, { ...ALL, write: false })).toEqual({ kind: "outreach", label: campaignsCopy.actionWriteEmails, disabled: true, note: campaignsCopy.outreachLater });
    expect(at("drafts_ready", "review_drafts")).toEqual({ kind: "reviewDrafts", label: campaignsCopy.actionReviewDrafts, href: "/inbox" });
    expect(at("ready_to_send", null)).toEqual({ kind: "outreach", label: campaignsCopy.actionSendEmails, disabled: true, note: campaignsCopy.sendLater });
    expect(at("drafting", null)).toBeNull();
  });

  it("draws nothing where the choice is in the card, where Relay is working, or where the page has no way to send it", () => {
    expect(at("research_stopped", "widen", { ...NONE, widen: true })).toBeNull();
    expect(at("people_needs_you", "choose_industry", { ...NONE, chooseIndustry: true })).toBeNull();
    expect(at("researching", null)).toBeNull();
    expect(at("finding_people", null)).toBeNull();
    expect(at("revealing", null)).toBeNull();
    expect(at("research_needs_you", "retry_research", { ...NONE, retry: true }, { ...ALL, retry: false })).toBeNull();
    expect(at("research_needs_you", "edit_brief", NONE, ALL, null)).toBeNull();
  });
});
