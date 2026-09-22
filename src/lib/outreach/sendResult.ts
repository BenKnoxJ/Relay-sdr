import { sendCopy } from "@/lib/copy/send";

/** A send's result as the rep reads it: the line, and whether it is a warning. */
export type SendNote = { note: string; warn: boolean };

type Outcome = { outcome: "sent" } | { outcome: "replied" } | { outcome: "sending" } | { outcome: "unverified" } | { outcome: "failed"; reason: "mailbox" | "provider" };

export function sendNoteOf(result: Outcome): SendNote {
  switch (result.outcome) {
    case "sent":
      return { note: sendCopy.sent, warn: false };
    case "replied":
      return { note: sendCopy.replied, warn: false };
    case "sending":
      return { note: sendCopy.sendingNow, warn: false };
    case "unverified":
      return { note: sendCopy.unverifiedNote, warn: true };
    case "failed":
      return { note: result.reason === "mailbox" ? sendCopy.failedMailbox : sendCopy.failedProvider, warn: true };
  }
}
