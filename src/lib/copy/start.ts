/**
 * Start, step 2: what Relay understood (signed mock §3d).
 *
 * The field labels are the mock's own words, and they are words rather than the
 * schema's key names for the obvious reason — `howMany` is a field name and
 * "How many, over how long" is a question. The bench renders these read-only;
 * slice 1 gives them their controls.
 */
export const startCopy = {
  title: "New campaign",
  understood: "Here is what Relay understood. Fix anything, then start the research.",

  field: {
    product: "Product",
    motion: "Motion",
    who: "Who",
    region: "Region",
    howMany: "How many",
    weeks: "Over how long",
    channels: "Channels",
  },

  /** Beside a field Relay filled in itself, which the mock draws with a dashed border. */
  guessed: "Relay guessed this",

  /**
   * What a field Relay could not fill shows instead of a value.
   *
   * Words and not a dash: the mock draws an empty control, which a read-only
   * render has no way to show, and an em dash never reaches a rep (§22.4, and
   * `BANNED_DASHES` refuses one in a copy file).
   */
  blank: "nothing yet",

  start: "Start research",
  startNote: "Usually 20 to 45 minutes. Nothing is bought or sent until you confirm the plan.",
} as const;
