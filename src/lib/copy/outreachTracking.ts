/**
 * Tracking a person's outreach (Relay P4): why the server turned a mark down.
 * One line per reason, in the rep's words; P5's drawer shows them as they are.
 */
export const outreachTrackingCopy = {
  notAllowed: "That step can't be marked that way now. Refresh and try again.",
  unknownStep: "That step isn't part of this sequence.",
  callResult: "Say how the call went: spoke, voicemail, no answer or wrong number.",
  alreadyRecorded: "That's already recorded for this person. Undo it first to change it.",
  cannotUndo: "That can't be undone.",
  undoLaterFirst: "Something marked later follows from this. Undo that first.",
  tooEarly: "That day is before the person started, or before the step it answers was sent.",
  notStarted: "Start outreach for this person first.",
  notApproved: "Approve this email before you mark it sent.",
  badDate: "Choose today or an earlier day.",
  badRange: "Choose a range of up to 92 days, with the start first.",
  emptyNote: "Write a note first.",
  longNote: "Keep a note to 2,000 characters.",
  badPhone: "Enter a phone number of up to 40 digits, spaces or + ( ) - . characters.",
} as const;
