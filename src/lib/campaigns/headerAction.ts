import { campaignsCopy } from "@/lib/copy/campaigns";

import type { CampaignSummaryFacts, ResearchActions } from "./types";

/**
 * The campaign page's one header control, from the backend's `nextAction`
 * (final MVP pass). The server decides what the rep can do next; this maps
 * that word to a label, and to whether the page can actually send it (it was
 * given a handler and the server allows it). A next action whose choice lives
 * in the main card (a widening, an industry to choose) draws no header button:
 * one control per decision.
 *
 * Client-safe: words and flags, no schema.
 */
export type HeaderAction =
  | { kind: "confirm" | "retry" | "retryPeople" | "retryReveal" | "reveal" | "outreach"; label: string; disabled?: boolean; note?: string }
  | { kind: "write"; label: string; note?: string }
  | { kind: "editBrief" | "reviewDrafts"; label: string; href: string };

export type HeaderHandlers = {
  confirm: boolean;
  retry: boolean;
  retryPeople: boolean;
  retryReveal: boolean;
  reveal: boolean;
  write: boolean;
};

export function headerActionOf(
  facts: Pick<CampaignSummaryFacts, "stage" | "nextAction">,
  can: ResearchActions,
  handlers: HeaderHandlers,
  options: { editHref?: string; revealBlocked: string },
): HeaderAction | null {
  const c = campaignsCopy;
  switch (facts.nextAction) {
    case "confirm":
      return can.confirm === true && handlers.confirm
        ? { kind: "confirm", label: c.actionConfirm, note: c.confirmNote }
        : { kind: "confirm", label: c.actionConfirm, disabled: true, note: c.confirmLater };
    case "retry_research":
      return handlers.retry ? { kind: "retry", label: c.actionTryAgain } : null;
    case "retry_people":
      return handlers.retryPeople ? { kind: "retryPeople", label: c.actionTryAgain } : null;
    case "retry_reveal":
      return handlers.retryReveal ? { kind: "retryReveal", label: c.actionTryAgain } : null;
    case "edit_brief":
      return options.editHref === undefined ? null : { kind: "editBrief", label: c.editBrief, href: options.editHref };
    case "review_people":
      // The second spend approval: it opens the figures, and only once somebody kept has an email to reveal or reuse.
      return can.reveal === true && handlers.reveal
        ? { kind: "reveal", label: c.actionReveal, note: c.revealNote }
        : { kind: "reveal", label: c.actionReveal, disabled: true, note: options.revealBlocked };
    case "write_emails":
      return can.write === true && handlers.write
        ? { kind: "write", label: c.actionWriteEmailsLive, note: c.writeNote }
        : { kind: "outreach", label: c.actionWriteEmails, disabled: true, note: c.outreachLater };
    case "review_drafts":
      return { kind: "reviewDrafts", label: c.actionReviewDrafts, href: "/inbox" };
    case "widen":
    case "choose_industry":
      return null;
    case null:
      // Drawn and not pressable: what comes next is not built here.
      if (facts.stage === "plan_ready") return { kind: "confirm", label: c.actionConfirm, disabled: true, note: c.confirmLater };
      if (facts.stage === "people_ready") return { kind: "outreach", label: c.actionWriteEmails, disabled: true, note: c.outreachLater };
      if (facts.stage === "ready_to_send") return { kind: "outreach", label: c.actionSendEmails, disabled: true, note: c.sendLater };
      return null;
  }
}
