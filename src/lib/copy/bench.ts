/**
 * The bench, which is a developer's screen and is held to the rep-words rule
 * anyway.
 *
 * The rule (§22.4) is that Relay never puts its own machinery on a screen, and
 * the reason to keep the bench inside it is not tidiness: the bench renders the
 * real components with the real copy, so a screen here that is allowed its own
 * private vocabulary stops being the screen it is standing in for. The names of
 * the agents themselves are not written here — they come from the definitions,
 * which is where they belong.
 */
export const benchCopy = {
  title: "Bench",

  /** Under the title on the index. */
  note: "Every checked-in output, in the screens a rep would see it in.",

  emptyHeading: "Nothing to look at yet",
  emptyBody: "Write one with npm run agent, and it appears here.",

  /** The two ways an output got here. */
  sourceRun: "ran here",
  sourceSample: "written down, never run",

  /** How the provider was reached. */
  recorded: "recorded",
  live: "live",

  /** The block above the render. */
  whatItCost: "What it cost",
  steps: "steps",
  spent: "spent",
  took: "took",
  notRun: "This one was never run, so there is nothing to report.",

  /** The same two, short enough for a chip on the index. */
  chipOk: "as promised",
  chipBad: "not as promised",

  /** The checks the bench settled by itself. */
  automatic: "Checked here",
  schemaOk: "The output is the shape the definition asks for",
  schemaBad: "The output is not the shape the definition asks for",
  ranOk: "Something actually ran, and every step of it was costed",
  ranBad: "Nothing ran",

  /** The rest, which is a person looking at the screen. */
  manual: "For you to check",
  manualNote: "Ticks are kept in this browser only. Nobody else sees them.",

  /** The render itself. */
  onScreen: "On screen",
  cannotRender: "There is no screen for this one yet, so here is what it holds.",
  back: "Back to the bench",
} as const;
