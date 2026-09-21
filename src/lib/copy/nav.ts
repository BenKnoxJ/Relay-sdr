/**
 * The shell: the six areas, in the signed order, plus the two things on the
 * right of the nav pill.
 *
 * The ORDER is the signed one (master doc §23.0: Home, Inbox, Campaigns,
 * Content, Settings), with Calendar after Inbox since Relay P6. It lives
 * in `src/components/Nav.tsx` as the order of its item list, not here —
 * this file is words. `tests/ui/nav.test.tsx`
 * asserts the rendered order, so the two cannot drift apart quietly.
 *
 * Inbox and Content are example surfaces until their rows exist, so the nav
 * carries them only under `RELAY_DEMO_SURFACES=show`; their words stay here
 * because the routes still render. There is no Admin word: the Admin area
 * lands in slice 3, and a pill for it before then was a door to nothing.
 */
export const navCopy = {
  home: "Home",
  inbox: "Inbox",
  calendar: "Calendar",
  campaigns: "Campaigns",
  content: "Content",
  settings: "Settings",

  /**
   * Absent from the nav until the first campaign exists (§23.1a, day one):
   * on day one the brief box is the only door.
   */
  newCampaign: "New campaign",

  /** The avatar carries initials, which read as nothing to a screen reader. */
  account: "Your account",
} as const;
