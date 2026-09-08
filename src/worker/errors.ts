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
/**
 * Field names whose value is a credential, and the value that follows them.
 *
 * Built rather than written, because it must not carry an `i` flag: the tail
 * below distinguishes `authorizationCode` from `author` by the case of the
 * letter after the keyword, and `i` would blunt exactly that. So each keyword
 * is spelled in both cases and the flags stay `g`.
 *
 *   * **In front of the keyword**, `[\w-]*` and nothing else. `\b` cannot fire
 *     in the middle of `access_token`, because an underscore is a word
 *     character, so an anchored keyword went straight past the three fields
 *     the Zoho and Graph token endpoints answer with. A loose prefix also
 *     takes the camel case the same fields wear in a JavaScript stack
 *     (`accessToken`).
 *   * **Behind it**, a plural or an `_id` or a digit, then optionally one more
 *     segment — `_`- or `-`-led (`AUTHORIZATION_HEADER`), or camelCase
 *     (`tokenValue`, `sessionId`, openid-client's own `tokenSet`). What both
 *     have in common is that they *start a new segment*: that is what makes
 *     `access_tokens` and `client_secrets` match while `author` and `keyboard`
 *     do not. Both negatives are in the test table, because "redact any name
 *     containing `key`" is the obvious wrong fix and it would redact the
 *     `keyboard` in somebody's error message.
 *
 * `key` and `auth` on their own are in the list deliberately: they cost a
 * redacted `orgId_key=` in the occasional Prisma message, and they buy every
 * `…_key` and every short-form `auth=` nobody has thought of yet. The one
 * known cost of the camelCase tail is an all-caps `AUTHOR=`, whose `OR` is
 * unreadable as anything but a second segment; `Author` and `author` are not
 * touched.
 */
const CREDENTIAL_WORDS = [
  "authorization",
  "authorisation",
  "credential",
  "password",
  "passwd",
  "session",
  "secret",
  "bearer",
  "cookie",
  "token",
  "auth",
  "pwd",
  "key",
];

/** `token` → `[tT][oO][kK][eE][nN]`, so the rule needs no `i` flag. */
function anyCase(word: string): string {
  return word.replace(/[a-z]/g, (letter) => `[${letter}${letter.toUpperCase()}]`);
}

const CREDENTIAL_NAME = new RegExp(
  `(?<![\\w-])([\\w-]*(?:${CREDENTIAL_WORDS.map(anyCase).join("|")})` +
    `(?:[eE]?[sS]|_[iI][dD]|\\d+)?(?:[_-][\\w-]+|[A-Z][a-z][\\w-]*)?)` +
    `["']?\\s*[:=]\\s*("[^"]*"|'[^']*'|[^\\s,;}\\]]+)`,
  "g",
);

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
  // The name is matched *around* the keyword rather than anchored to the end
  // of it, and both sides earned their shape from a miss. See
  // `CREDENTIAL_NAME` for what each side does and what it deliberately lets
  // through.
  [CREDENTIAL_NAME, `$1=${REDACTED}`],
  // A Zoho OAuth token carries no prefix a name rule would recognise — it is
  // the client id's `1000.` and two long runs — so it is only ever caught by
  // its shape. Relay refreshes one on every CRM write, which makes it the
  // single most likely credential to reach this function.
  [/\b1000\.[A-Za-z0-9]{20,}\.[A-Za-z0-9]{20,}\b/g, REDACTED],
  // `sk-…`, `pk-…`, `rk-…` — and `sk-ant-…`, whole, because `-` is inside the
  // class and the match runs to the end of the key.
  [/\b(sk|pk|rk)[-_][A-Za-z0-9_-]{8,}/g, REDACTED],
  [/\bAKIA[0-9A-Z]{16}\b/g, REDACTED],
  [/\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g, REDACTED],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, REDACTED],
  // A JWT is three base64url segments; the middle one is the claims.
  [/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g, REDACTED],
  // The last net: a long opaque run sitting in a value position, whatever the
  // field is called. A provider that answers with a field nobody here has
  // heard of still answers with something 32 characters wide after a `:` or an
  // `=`, and that is enough to redact on.
  //
  // Three lookaheads keep it off the things that column is *for*, each one
  // added because the rule ate something a reviewer needs:
  //
  //   * a uuid — the job or org id somebody looks up;
  //   * anything without all three of upper, lower and digit, which is what a
  //     random token has and prose does not. `Error: xxxx…`, a long unspaced
  //     message, is the commonest shape this function ever sees, and a W3C
  //     `traceparent` is lower-case hex;
  //   * anything with two or more underscores, which is a `SCREAMING_SNAKE`
  //     error code — `P2002_UNIQUE_CONSTRAINT_VIOLATION_ON_FIELDS_orgId` is
  //     the single most likely long value in a Prisma failure, and redacting
  //     it would leave the column safe and useless at once.
  //
  // Known residuals, both deliberate: a base64url token that happens to carry
  // two underscores, and a bare credential with no field name and no
  // recognised shape. This function is the second line. The first is not
  // putting secrets in exception messages.
  [
    /(?<=[:=]\s{0,4}["']?)(?![0-9a-f]{8}-[0-9a-f]{4}-)(?![A-Za-z0-9+/-]*_[A-Za-z0-9+/-]*_)(?=[A-Za-z0-9+/_-]*\d)(?=[A-Za-z0-9+/_-]*[a-z])(?=[A-Za-z0-9+/_-]*[A-Z])[A-Za-z0-9+/_-]{32,}={0,2}/g,
    REDACTED,
  ],
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
