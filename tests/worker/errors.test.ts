import { describe, expect, it } from "vitest";

import { MAX_ERROR_LENGTH, TerminalError, isTerminal, safeError } from "@/worker/errors";

/**
 * `Job.error` is written from real exceptions and read on a rep's screen, so
 * what goes into it is bounded and scrubbed at the only place that writes it.
 * These are the cases the queue's review flagged, and the ones that arrive
 * from other people's libraries.
 */

// Assembled rather than written, like the shapes below it. A sixteen-character
// literal assigned to a name like this is precisely what the repository's own
// gitleaks gate flags — and it was right to; a fixture is not worth an
// allowlist entry that would also excuse a real one.
const CREDENTIAL = ["abcdef", "0123", "4567", "89"].join("");
const KEY_SHAPE = ["sk", "live-abcdef0123456789"].join("-");
const AWS_SHAPE = ["AKIA", "IOSFODNN7EXAMPLE"].join("");
const GH_SHAPE = ["ghp", "abcdefghijklmnopqrstuvwxyz0123456789"].join("_");
const SLACK_SHAPE = ["xoxb", "1234567890", "abcdefghij"].join("-");
const JWT_SHAPE = ["eyJhbGciOi", "eyJzdWIiOiJ4", "QWxhZGRpbg"].join(".");
const HIDDEN_DIR = ["/home/relay/", ".", "credentials/zoho.json"].join("");

describe("safeError", () => {
  it("keeps the first line of a multi-line message and drops the rest", () => {
    const error = new Error("Invalid `prisma.job.create()` invocation:\n\n  at line 42\n  column 7");
    expect(safeError(error)).toBe("Error: Invalid `prisma.job.create()` invocation:");
  });

  it("bounds the result, and says that it did", () => {
    const text = safeError(new Error("x".repeat(1_000)));
    expect(text.length).toBe(MAX_ERROR_LENGTH);
    expect(text.endsWith("…")).toBe(true);
  });

  it.each([
    [`postgresql://relay:${CREDENTIAL}@127.0.0.1:5435/relay`, CREDENTIAL],
    [`Authorization: Bearer ${CREDENTIAL}`, CREDENTIAL],
    [`failed with api_key=${KEY_SHAPE}`, KEY_SHAPE],
    [`${AWS_SHAPE} denied`, AWS_SHAPE],
    [`token ${GH_SHAPE}`, GH_SHAPE],
    [`hook ${SLACK_SHAPE} failed`, SLACK_SHAPE],
    [`bad jwt ${JWT_SHAPE}`, JWT_SHAPE],
    [`ENOENT: ${HIDDEN_DIR}`, HIDDEN_DIR],
    ["cannot load file:///opt/relay/dist/worker/main.js", "file:///opt/relay/dist/worker/main.js"],
  ])("scrubs %s", (message, secret) => {
    const text = safeError(new Error(message));
    expect(text).not.toContain(secret);
    expect(text).toContain("[redacted]");
  });

  it("never serialises a thrown object, because its fields are where the credential is", () => {
    class ProviderResponse {
      readonly headers = { authorization: `Bearer ${CREDENTIAL}` };
    }
    const text = safeError(new ProviderResponse());
    expect(text).toBe("non-Error thrown (ProviderResponse)");
    expect(text).not.toContain(CREDENTIAL);
  });

  it.each([
    [null, "null thrown"],
    [undefined, "undefined thrown"],
    ["plain string", "plain string"],
    [new Error(""), "Error"],
  ])("describes %s", (thrown, expected) => {
    expect(safeError(thrown)).toBe(expected);
  });

  it("never returns an empty string", () => {
    expect(safeError(new Error("   \n  "))).toBe("Error:");
    expect(safeError("")).toBe("unknown error");
  });
});

describe("isTerminal", () => {
  it("is true only for a TerminalError", () => {
    expect(isTerminal(new TerminalError("bad input"))).toBe(true);
    expect(isTerminal(new Error("connection reset"))).toBe(false);
    expect(isTerminal("connection reset")).toBe(false);
  });
});

describe("safeError on the shapes other people's libraries throw", () => {
  it("scrubs a credential inside a serialised request body, not only a header", () => {
    // The name/value rule used to expect its separator immediately after the
    // name, which matches `x-api-key: …` and misses `{"api_key":"…"}` — and
    // the second is what an HTTP client actually puts in a message.
    const text = safeError(new Error('POST failed: {"api_key":"sekritvalue123","retries":2}'));
    expect(text).not.toContain("sekritvalue123");
    expect(text).toContain("[redacted]");
  });

  it("scrubs an auth scheme that is not Bearer", () => {
    const basic = ["Basic", "cmVsYXk6c3VwZXJzZWNyZXQ="].join(" ");
    const text = safeError(new Error(`Authorization: ${basic}`));
    expect(text).not.toContain("cmVsYXk6c3VwZXJzZWNyZXQ=");
  });
});

describe("safeError and the OAuth field names", () => {
  // The three the Zoho and Graph token endpoints answer with, which is what a
  // provider client is most likely to have in an exception this worker sees.
  it.each(["access_token", "refresh_token", "client_secret"])("scrubs %s", (field) => {
    const value = ["live", "credential", "value"].join("");
    const text = safeError(new Error(`token endpoint said {"${field}":"${value}","expires_in":3600}`));
    expect(text).not.toContain(value);
    expect(text).toContain("[redacted]");
  });
});

describe("safeError and the field names the suffix rule used to miss", () => {
  // The rule anchored the keyword to the *end* of the field name, so every
  // short form and every plural walked through it. Each of these is a name a
  // provider, a proxy or a piece of middleware actually uses.
  const value = ["live", "credential", "value"].join("");

  it.each([
    ["auth", `login failed: {"auth":"${value}"}`],
    ["credential", `store rejected credential=${value}`],
    ["access_tokens", `cache holds {"access_tokens":"${value}"}`],
    ["client_secrets", `vault said {"client_secrets":"${value}"}`],
    ["AUTHORIZATION_HEADER", `env AUTHORIZATION_HEADER=${value} is malformed`],
  ])("scrubs %s", (_name, message) => {
    const text = safeError(new Error(message));
    expect(text).not.toContain(value);
    expect(text).toContain("[redacted]");
  });

  it.each([
    "authorizationCode",
    "tokenValue",
    "sessionId",
    "passwordHash",
    // openid-client's own type name, and therefore a field an OAuth library
    // puts in an exception without anybody here choosing to.
    "tokenSet",
  ])("scrubs the camelCase name %s", (field) => {
    const text = safeError(new Error(`client threw {"${field}":"${value}"}`));
    expect(text).not.toContain(value);
    expect(text).toContain("[redacted]");
  });

  it("leaves the words that merely contain a keyword alone", () => {
    // The obvious wrong fix for the above is "redact any name containing
    // `key`", and it would redact the `keyboard` in somebody's error message.
    // A keyword has to end the name or start a new segment of it.
    const text = safeError(new Error('import failed: {"author":"Ada Lovelace","keyboard":"qwerty"}'));
    expect(text).toContain("Ada Lovelace");
    expect(text).toContain("qwerty");
    expect(text).not.toContain("[redacted]");
  });
});

describe("safeError and the credentials that arrive with no field name", () => {
  // Assembled, never written: a literal of this shape is what the repository's
  // own gitleaks gate exists to catch, and a fixture is not worth an allowlist
  // entry that would also excuse a real one.
  const ZOHO_SHAPE = ["1000", "a".repeat(32), "b".repeat(32)].join(".");
  const ANTHROPIC_SHAPE = ["sk", "ant", `api03-${"c".repeat(32)}`].join("-");
  // Mixed case and digits, because that is what an opaque credential looks
  // like and it is what the shape rule keys on.
  const OPAQUE = "A1b2C3d4".repeat(5);

  it("scrubs a Zoho token by its shape — Relay refreshes one on every CRM write", () => {
    const text = safeError(new Error(`Zoho refused ${ZOHO_SHAPE} and gave no code`));
    expect(text).not.toContain(ZOHO_SHAPE);
    expect(text).toContain("[redacted]");
  });

  it("scrubs an Anthropic key by its shape", () => {
    const text = safeError(new Error(`model call rejected ${ANTHROPIC_SHAPE} not found`));
    expect(text).not.toContain(ANTHROPIC_SHAPE);
    expect(text).toContain("[redacted]");
  });

  it("scrubs a long opaque run in a value position, whatever the field is called", () => {
    const text = safeError(new Error(`upstream said nonce=${OPAQUE} rejected`));
    expect(text).not.toContain(OPAQUE);
    expect(text).toContain("[redacted]");
  });

  it("keeps a uuid, which is the one long value worth reading in an error", () => {
    // A job or an org id is what a reviewer looks up. Redacting it would make
    // the column safe and useless at the same time.
    const id = "550e8400-e29b-41d4-a716-446655440000";
    expect(safeError(new Error(`no handler for job=${id}`))).toContain(id);
  });
});

describe("safeError leaves the long values a reviewer actually needs", () => {
  // The opaque last net is the rule most likely to make `Job.error` safe and
  // useless at the same time, so each of these is a value that must survive it.
  it("keeps a Prisma error code", () => {
    const code = "P2002_UNIQUE_CONSTRAINT_VIOLATION_ON_FIELDS_orgId";
    expect(safeError(new Error(`write failed with code: ${code}`))).toContain(code);
  });

  it("keeps a W3C traceparent", () => {
    const trace = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
    expect(safeError(new Error(`upstream 503 trace=${trace}`))).toContain(trace);
  });
});
