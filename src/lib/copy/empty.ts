/**
 * The areas that are in the nav from day one with nothing behind them yet
 * (master doc §23.0, "an area with nothing behind it yet opens to an empty
 * state that says what is coming").
 *
 * Every one of these obeys §22.7: it says what happens next, not that there is
 * nothing here. The heading and the line are separate strings because the
 * signed empty-state pattern is a heading and one paragraph (mock, `.empty`),
 * not one sentence.
 */
export const emptyCopy = {
  /**
   * Inbox is not here any more: Task 9d gave it a queue, and its empty state
   * ("All clear. Next drafts Thursday 09:00.") lives with the rest of its
   * words in `copy/inbox.ts`.
   */
  campaigns: {
    title: "Campaigns",
    note: "none yet",
    heading: "No campaigns yet",
    body: "Start one from Home.",
  },
} as const;
