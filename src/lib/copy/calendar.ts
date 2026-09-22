/**
 * The outreach calendar (Relay P6): a Monday-to-Friday week of what is due
 * across the rep's campaigns, and Home's one line about today.
 *
 * Interpolation happens at the call site: a count is written beside a word
 * here, so "3 need approval" is `3` and `needApproval`.
 */
export const calendarCopy = {
  title: "Calendar",
  weekOf: "Week of",

  weekNav: "Choose a week",
  previousWeek: "Previous week",
  nextWeek: "Next week",
  thisWeek: "This week",
  /** Decoration beside the words, hidden from a screen reader. */
  previousGlyph: "←",
  nextGlyph: "→",

  filtersLabel: "Filters",
  filterCampaign: "Campaign",
  filterCampaignAll: "All campaigns",
  filterChannel: "Channel",
  filterChannelAll: "All channels",

  overdue: "Overdue",
  nothingOverdue: "Nothing overdue.",
  today: "Today",
  nothingThisDay: "Nothing due.",
  empty: "Nothing due this week.",
  /** After a count: "1 needs approval", "3 need approval". */
  needApprovalOne: "needs approval",
  needApproval: "need approval",
  needsApproval: "Needs approval",
  /** Beside a day with more emails due than the daily cap: "Over the daily cap of 30". */
  overCap: "Over the daily cap of",
  /** After a count: "2 campaigns paused", "1 campaign paused". */
  campaignsPaused: "campaigns paused",
  campaignPaused: "campaign paused",

  /** The glyph is decoration; the word beside it, read by a screen reader, is the name. */
  channelGlyph: { email: "✉", linkedin: "in", call: "☎" },
  channelName: { email: "Email", linkedin: "LinkedIn", call: "Call" },
  channelFilter: { email: "Email", linkedin: "LinkedIn", call: "Calls" },
  /** After a count, one and many. */
  channelOne: { email: "email", linkedin: "LinkedIn", call: "call" },
  channelMany: { email: "emails", linkedin: "LinkedIn", call: "calls" },

  /** Home's row: "Due today: 4 emails · 3 LinkedIn · 2 calls". */
  dueTodayLabel: "Due today",
  nothingDueToday: "Nothing due today",
  /** After a count: "· 5 overdue". */
  overdueCount: "overdue",
  openCalendar: "Open calendar",
} as const;
