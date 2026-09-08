/**
 * What the worker is allowed to write into `Job.error`, and how it decides
 * whether a failure is worth another attempt.
 *
 * Two things meet here, and they meet at the first caller on purpose: this is
 * the first code in the repository that puts a real exception's text into a
 * database column, so it is the first place the two Sentinel minors from the
 * queue's pull request can actually be closed rather than described.
 */

/**
 * A failure that another attempt cannot fix: the input is the wrong shape, the
 * kind is unknown, the side effect is already recorded. Anything else the
 * worker sees is treated as retryable, which is the safe default — a job
 * requeued for a fault that was in fact permanent burns its attempts and lands
 * in `failed` a few minutes later, while a job failed for a fault that was in
 * fact transient is work silently dropped.
 */
export class TerminalError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "TerminalError";
  }
}

/** The `Job.error` column's budget. Long enough to be useful, short enough not to be a log. */
export const MAX_ERROR_LENGTH = 200;

/** What replaces anything that looks like a credential. */
const REDACTED = "[redacted]";

/**
 * Patterns whose *match* is a secret, a header carrying one, or a filesystem
 * path that describes this machine rather than the failure.
 *
 * The list is deliberately over-broad. A false positive costs a reviewer one
 * `[redacted]` in an error string they can reproduce locally; a false negative
 * writes a live provider token into a column that Task 11's timeline renders
 * to a rep's screen. It is not a substitute for not putting secrets in
 * exception messages — it is the second line, for the messages other people's
 * libraries throw.
 */
const SCRUB: Array<[RegExp, string]> = [
  // Connection strings: keep the shape, lose the credential.
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, `$1${REDACTED}@`],
  // The auth schemes, and they must come before the name/value rule below:
  // `Authorization: Bearer abc` matched as a name and a value takes the
  // *scheme* for the value and leaves the credential standing in the open.
  [/\b(Bearer|Basic|Token|Digest|ApiKey)\s+[^\s,;"']+/gi, `$1 ${REDACTED}`],
  // `x-api-key: …`, `?token=…`, `{"secret": "…"}`, and `Authorization:` with
  // whatever scheme is not one of the above.
  //
  // The optional quote after the name is not decoration: a name/value pair
  // inside JSON is `"api_key":"…"`, and a rule that expects the separator
  // immediately after the name matches a header and walks straight past every
  // serialised request body — which is the shape a provider client actually
  // throws.
  //
  // The name is a *suffix* match (`[\w-]*` in front) rather than a fixed list,
  // and that is the second thing this rule got wrong: `\b` cannot fire in the
  // middle of `access_token`, because an underscore is a word character. So
  // `access_token`, `refresh_token` and `client_secret` — the three fields the
  // Zoho and Graph token endpoints answer with, and therefore the three most
  // likely to be inside an exception this repository ever sees — went through
  // untouched. `key` on its own is in the list deliberately: it costs a
  // redacted `orgId_key=` in the occasional Prisma message, and it buys every
  // `…_key` nobody has thought of yet.
  [
    /(?<![\w-])([\w-]*(?:authorization|token|secret|password|passwd|pwd|key))["']?\s*[:=]\s*("[^"]*"|'[^']*'|[^\s,;}\]]+)/gi,
    `$1=${REDACTED}`,
  ],
  // Provider key shapes, including the ones gitleaks scans commits for.
  [/\b(sk|pk|rk)[-_][A-Za-z0-9_-]{8,}/g, REDACTED],
  [/\bAKIA[0-9A-Z]{16}\b/g, REDACTED],
  [/\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g, REDACTED],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, REDACTED],
  // A JWT is three base64url segments; the middle one is the claims.
  [/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g, REDACTED],
  // Absolute paths and file URLs — the deploy layout, not the fault.
  [/\bfile:\/\/\/\S+/g, REDACTED],
  [/(?<![\w.])\/(?:home|Users|root|var|usr|opt|etc|tmp|srv)\/\S*/g, REDACTED],
];

/**
 * Turn an unknown thrown value into a line that is safe to store.
 *
 * Three things happen, in this order, and each is load-bearing:
 *
 *   1. **The message only, never the stack.** `String(error)` on an Error gives
 *      `name: message`, not the trace — but a *message* can itself be
 *      multi-line (a Prisma connector error carries its query and its position
 *      over several lines), so only the first non-empty line is kept.
 *   2. **Scrubbed.** See `SCRUB`.
 *   3. **Bounded**, with an ellipsis so a reader can tell a truncated line from
 *      a short one.
 *
 * A value that is not an Error and not a string — someone threw an object —
 * becomes its constructor name rather than `[object Object]`, and never its
 * serialised contents: the fields of a thrown response object are exactly
 * where a token would be.
 */
export function safeError(error: unknown): string {
  const raw = describe(error);

  const firstLine = raw
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line !== "");
  let text = firstLine ?? "unknown error";

  for (const [pattern, replacement] of SCRUB) text = text.replace(pattern, replacement);

  // Collapse whitespace last: a scrubbed multi-space run is noise, and a tab
  // inside a JSON log line is not worth the escape.
  text = text.replace(/\s+/g, " ").trim();
  if (text === "") text = "unknown error";

  return text.length <= MAX_ERROR_LENGTH ? text : `${text.slice(0, MAX_ERROR_LENGTH - 1)}…`;
}

function describe(error: unknown): string {
  if (error instanceof Error) {
    return error.message === "" ? error.name : `${error.name}: ${error.message}`;
  }
  if (typeof error === "string") return error;
  if (typeof error === "number" || typeof error === "boolean" || typeof error === "bigint") {
    return String(error);
  }
  if (error === null) return "null thrown";
  if (error === undefined) return "undefined thrown";
  // Not stringified: an object thrown by an HTTP client holds the request, and
  // the request holds the Authorization header.
  const name: unknown = (error as { constructor?: { name?: unknown } }).constructor?.name;
  return typeof name === "string" ? `non-Error thrown (${name})` : "non-Error thrown";
}

/** True when this failure should not be retried. */
export function isTerminal(error: unknown): boolean {
  return error instanceof TerminalError;
}
