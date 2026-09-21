/**
 * Find more people (P5b): the words on the campaign page's Find more card, the
 * batch line while a later batch is under way, the People list's batch, and
 * the activity.
 */
export const findMoreCopy = {
  label: "Find more people",
  open: "Find more people",
  /** "Batch 2 runs the same search again, leaving out everyone already in this campaign or held in another." */
  intro: "runs the same search again, leaving out everyone already in this campaign or held in another. You review, reveal and write for them as before.",
  howMany: "How many people",
  /** "About 20 search credits". */
  about: "About",
  searchCredits: "search credits",
  /** "12 of 40 left of the approved search limit". */
  of: "of",
  leftOfCap: "left of the approved search limit",
  /** When the estimate is more than what is left. */
  capUsed: "That's more than is left of the approved search limit. Finding them approves a new search limit of",
  credits: "credits",
  sample: "Sample people and credits. Nothing is bought.",
  confirm: "Find people",
  confirmNewCap: "Approve and find people",
  finding: "Finding",
  cancel: "Cancel",
  batch: "Batch",
  /** Lines while a later batch is under way: "Batch 2: 18 found, review them". */
  lineFinding: "finding people",
  lineFound: "found, review them",
  lineStopped: "found nobody new. Try again or find more people.",
  lineRevealing: "revealing emails",
  lineReady: "emails ready, write outreach",
  /** People list: "Batch 2 · started Tue 29 Sep", or "Batch 2 · not started". */
  started: "started",
  notStarted: "not started",
  filterBatch: "Batch",
  filterAllBatches: "All batches",
  toastFinding: "Relay is finding more people now. Nothing is revealed or sent.",
  capUsedRefused: "What's left of the search limit has changed. Refresh the page to see it.",
  activity: "Asked for more people:",
  activityBatch: "batch",
  activityNewCap: "with a new search limit of",
} as const;
