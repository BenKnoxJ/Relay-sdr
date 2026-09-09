/**
 * Approvals (master doc §22.7, §23.1d). The Inbox is slice 1, so the only
 * strings here are the two answers approving can give.
 *
 * Both are written for a rep and neither names a mechanism: "sending" is what
 * happens, and the queue, the worker and the job that carry it out are ours to
 * know about. §22.4's rule applied to a control rather than to a page.
 */
export const approvalsCopy = {
  /** Approved just now. */
  approved: "Approved. Sending shortly.",
  /**
   * Approved already, by this rep or another. A second click, a stale tab and a
   * retried request are all the same act, and telling a rep their approval
   * "failed" because it had already worked would be a lie about their own work.
   */
  alreadyApproved: "Already approved. Sending shortly.",
  /**
   * The draft is not one this rep can approve, whether because it does not
   * exist or because it belongs to another company. One line for both: a
   * message that told them apart would answer "does this id exist elsewhere?"
   * for anyone who asked.
   */
  notFound: "That draft is no longer available.",
} as const;
