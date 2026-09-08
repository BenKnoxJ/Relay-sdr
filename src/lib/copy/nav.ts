/**
 * The shell: the five areas, in the signed order, plus the two things on the
 * right of the nav pill.
 *
 * The ORDER is the signed one (master doc §23.0: Home, Inbox, Campaigns,
 * Content, Settings, with Admin after Settings for admins) and it lives in
 * `src/components/Nav.tsx` as the order of its item list, not here — this file
 * is words. `tests/ui/nav.test.tsx` asserts the rendered order, so the two
 * cannot drift apart quietly.
 */
export const navCopy = {
  home: "Home",
  inbox: "Inbox",
  campaigns: "Campaigns",
  content: "Content",
  settings: "Settings",

  /**
   * The admin item, as the signed mock draws it: a quiet dashed pill on the
   * right rather than a sixth link, saying who else can see it. It is rendered
   * only for an admin (§23.0, "absent from a rep's nav"), so a rep never reads
   * these words at all.
   */
  admin: "Admin · you only",

  /**
   * Absent from the nav until the first campaign exists (§23.1a, day one):
   * on day one the brief box is the only door.
   */
  newCampaign: "New campaign",

  /** The avatar carries initials, which read as nothing to a screen reader. */
  account: "Your account",
} as const;
