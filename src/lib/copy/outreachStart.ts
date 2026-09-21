/**
 * Start outreach, and Pause and Resume a campaign (Relay P3): the words on
 * the campaign page's Outreach card and in its activity.
 */
export const outreachStartCopy = {
  label: "Outreach",
  notStarted: "Not started",
  startedOn: "Outreach started on",
  person: "person",
  people: "people",
  /** "Start outreach for 18 people". */
  startFor: "Start outreach for",
  waiting: "waiting to start",
  startOnLabel: "Start on",
  startHint: "Each person's steps are dated from this day, Monday to Friday. A weekend day starts on the Monday after. People added later start on their own day.",
  confirm: "Start outreach",
  starting: "Starting",
  cancel: "Cancel",
  paused: "Paused",
  pausedNote: "Nothing is due and nothing is sent until you resume.",
  pause: "Pause campaign",
  resume: "Resume campaign",
  nothingToStart: "Everyone with drafts has already started.",
  badDate: "Choose today or a later day.",
  tooFar: "Choose a day within the next 30 days.",
  /** "Start outreach for 6 people on Tue 22 Sep". */
  startOnDay: "on",
  cannotChange: "That didn't work. Refresh the page and try again.",
  activityStarted: "Started outreach on",
  activityFor: "for",
  activityPaused: "Paused the campaign's outreach",
  activityResumed: "Resumed the campaign's outreach",
  /** A day as "Tue 22 Sep": fixed names, so the server and the browser draw the same words. */
  weekdays: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"],
  months: ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"],
} as const;
