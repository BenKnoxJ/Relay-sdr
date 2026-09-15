/**
 * Every on-screen string lives in a copy file (master doc §24, "one linted copy
 * file of every on-screen string"). Rep words only — no machine vocabulary.
 *
 * The three shell states live here too: the quiet line while a page loads,
 * the page a fault lands on, and the page a wrong address lands on. Each says
 * what to do next and, where it matters, that nothing was bought or sent.
 */
export const shellCopy = {
  appName: "Relay",

  /** `src/app/(app)/loading.tsx`: one line, no spinner. */
  loading: "Loading…",

  /** `src/app/(app)/error.tsx`. */
  errorHeading: "Something went wrong",
  errorBody: "Reload the page. Nothing was bought or sent.",
  reload: "Reload",

  /** `src/app/(app)/not-found.tsx`. */
  notFoundHeading: "This page isn't here.",
  notFoundHome: "Home",
} as const;
