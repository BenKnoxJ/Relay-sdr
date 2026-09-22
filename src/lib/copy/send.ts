/**
 * Sending from Outlook and how the rep's emails look (Relay P7). Every string
 * the Send button, its notes, the Inbox's ready list and Settings' email card
 * show. Rep words only: `tests/lib/copy.test.ts` sweeps this file.
 */
export const sendCopy = {
  send: "Send",
  sending: "Sending…",
  /** "Send from Thu 25 Sep": approved, not due yet. */
  sendFrom: "Send from",
  checkIt: "Check it went",
  checking: "Checking…",
  paused: "Paused, so nothing sends.",
  connect: "Connect your mailbox to send",
  /** Follows the day's cap: "30 sent today; the rest can go tomorrow." */
  capNote: "sent today; the rest can go tomorrow.",
  byHand: "Email 1 went by hand, so copy this one and send it yourself.",
  sendingNow: "This one is sending now.",
  unverifiedNote: "We couldn't confirm this went. Check your Sent Items before sending it again by hand.",
  sent: "Sent from your mailbox.",
  replied: "They replied, so this wasn't sent.",
  failedMailbox: "It didn't send: your mailbox needs connecting again in Settings.",
  failedProvider: "It didn't send. Try again in a minute.",
  refused: {
    none: "There's nothing to send for this email now. Refresh and try again.",
    not_due: "This email isn't due yet.",
    paused: "This campaign is paused, so nothing sends.",
    no_mailbox: "Connect your mailbox to send.",
    cap: "You've sent today's 30; the rest can go tomorrow.",
    by_hand: "Email 1 went by hand, so copy this one and send it yourself.",
    not_found: "That person isn't on one of your campaigns.",
  },
  ready: {
    title: "Ready to send",
    note: "Approved emails, due first. Each sends from your mailbox when you press Send.",
    empty: "Nothing approved is waiting to send.",
    /** "4 of 30 sent today" */
    of: "of",
    sentToday: "sent today",
    /** "Email 2" */
    email: "Email",
    due: "Due",
  },
} as const;

export const emailLookCopy = {
  title: "Your email look",
  note: "Relay sends your emails from Outlook in this font, with this signature. Paste your signature as it appears in Outlook.",
  font: "Font",
  size: "Size",
  sizeUnit: "pt",
  signature: "Signature",
  signaturePlaceholder: "Paste your Outlook signature here",
  preview: "Preview",
  previewNote: "A sample email as your prospects will see it.",
  save: "Save",
  saving: "Saving…",
  saved: "Saved",
  clear: "Clear signature",
  refused: {
    bad_font: "Choose one of the fonts listed.",
    bad_size: "Choose a size from 8 to 20.",
    long_signature: "That signature is too long. Paste it without large images.",
  },
} as const;
