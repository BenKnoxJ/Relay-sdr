/**
 * Signing in, in a rep's words.
 *
 * Every string here reaches a screen or a rep-facing error, so the sweep in
 * `tests/lib/copy.test.ts` checks it against the rep-words rule (master doc
 * §22.4) the moment this file lands. Nothing names Clerk, a role check or a
 * procedure: a rep who cannot open a page is told who can open it, not which
 * guard refused them.
 */
export const authCopy = {
  /** The sign-in screen. */
  signInTitle: "Sign in to Relay",
  signInSubtitle: "Use the work email your account was set up with.",

  /**
   * There is no sign-in to show: this copy of Relay has no account behind it,
   * which is the local bypass and CI, and is a fact about the machine rather
   * than a failure the reader can do anything about.
   */
  signInUnavailable: "This copy of Relay signs you in without a password.",

  /**
   * Signed in with the provider, but carrying nothing Relay can place them by:
   * no work address, or an address at a free mailbox provider, which is one
   * provider rather than one company.
   */
  needsWorkEmail: "Relay needs your work email address. Ask your admin to set you up with one.",

  /**
   * The address is already linked to a different sign-in account. Not a
   * switched-off account and not a wrong password, so it says neither: nobody
   * can fix this from a sign-in screen, and the admin is the one who can.
   */
  addressAlreadyInUse: "Your admin needs to sort this address out before you can sign in.",

  /** A rep opened something only the sales manager can open. */
  adminOnly: "That page is for your admin.",

  /** No session at all: signed out, or the sign-in never completed. */
  signedOut: "Sign in to pick up where you left off.",

  /**
   * The one account state that is not a sign-in problem: the person exists and
   * has been switched off. Says so without inviting a retry that cannot work.
   */
  noLongerActive: "This account is switched off. Ask your admin to switch it back on.",
} as const;
