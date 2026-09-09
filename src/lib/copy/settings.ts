/**
 * Settings, as far as the shell goes.
 *
 * The four card headings are the signed ones (master doc §23.1f, and the mock's
 * section 5) and they are all this task builds: every card carries the same one
 * line saying it arrives with the connect step. Task 10b fills Mailbox in, and
 * this file is where its words go.
 */
export const settingsCopy = {
  title: "Settings",
  /** The mono note beside the page title, from the signed mock, section 5. */
  note: "yours, not the org's",

  /** One line, under every card, until each card has something to show. */
  coming: "Coming with the connect step",

  mailbox: "Mailbox",
  linkedin: "LinkedIn",
  voice: "Your voice",
  calls: "Calls",
} as const;
