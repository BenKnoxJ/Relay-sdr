/**
 * What Relay puts around a written body (M2, 23 Sep 2026).
 *
 * The writer writes the body and nothing else. Everything else a prospect
 * reads is Relay's: the greeting above it, the rep's sign-off below it, the
 * signature they pasted from Outlook, and the soft opt-out line.
 *
 * The opt-out is the reason this module exists. Relay's own lawful-basis text
 * promises every cold email carries a way out, and until now nothing added
 * one: the body rule held (no draft writes its own opt-out, correctly), but
 * the rep sends by hand, so what they copied had no opt-out in it and the
 * promise went undelivered. It is added here, in the one place the preview,
 * the Copy button and the send path all read, so the three cannot drift.
 *
 * Email only. A LinkedIn note and a call script carry neither a signature nor
 * an opt-out: a connection request is not a cold email, and reading an opt-out
 * line down the phone is absurd.
 */

/** Benny-san's wording, 22 Sep 2026. Not paraphrased anywhere. */
export const OPT_OUT_LINE = "If this isn't relevant, just reply and I won't follow up.";

export type Envelope = {
  /** "Hi Avery," */
  greeting: string;
  /** The rep's first name, or empty when Relay does not know it. */
  signOff: string;
  /** The rep's Settings signature as plain lines; empty when they have none. */
  signature: string;
  /** The soft opt-out. Always present on an email. */
  optOut: string;
};

const BLOCK = /<\/(?:p|div|tr|li|h[1-6]|table|blockquote)>|<br\s*\/?>|<\/?(?:p|div|tr|li|h[1-6]|table|blockquote)[^>]*>/gi;

/**
 * A pasted HTML signature as the plain lines a card shows and a clipboard
 * carries. Block elements and `<br>` become line breaks, every other tag is
 * dropped, entities are unescaped, and runs of blank lines collapse.
 *
 * Display only. The sent email keeps the rep's real HTML signature
 * (`emailHtml`), because that is the one they built in Outlook.
 */
export function signatureText(html: string): string {
  const withBreaks = html.replace(BLOCK, "\n");
  const stripped = withBreaks.replace(/<[^>]*>/g, "");
  const unescaped = stripped
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&apos;/gi, "'");
  return unescaped
    .split("\n")
    .map((line) => line.replace(/[ \t ]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** The envelope around one person's email. */
export function envelopeOf(input: { firstName: string; repName: string; signature: string }): Envelope {
  return {
    greeting: `Hi ${input.firstName},`,
    signOff: input.repName.trim(),
    signature: signatureText(input.signature),
    optOut: OPT_OUT_LINE,
  };
}

/**
 * The email exactly as the rep copies and sends it: greeting, body, sign-off,
 * signature, opt-out. Blank lines between the parts, and a part Relay does
 * not have is left out rather than left as a gap.
 */
export function emailCopyText(body: string, envelope: Envelope | undefined): string {
  if (envelope === undefined) return body.trim();
  return [envelope.greeting, body.trim(), envelope.signOff, envelope.signature, envelope.optOut]
    .map((part) => part.trim())
    .filter((part) => part !== "")
    .join("\n\n");
}
