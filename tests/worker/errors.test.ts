import { describe, expect, it } from "vitest";

import { MAX_ERROR_LENGTH, TerminalError, isTerminal, safeError } from "@/worker/errors";

/**
 * `Job.error` is written from real exceptions and read on a rep's screen, so
 * what goes into it is bounded and scrubbed at the only place that writes it.
 * These are the cases the queue's review flagged, and the ones that arrive
 * from other people's libraries.
 */

const CREDENTIAL = "abcdef0123456789";
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
    const value = "livecredentialvalue";
    const text = safeError(new Error(`token endpoint said {"${field}":"${value}","expires_in":3600}`));
    expect(text).not.toContain(value);
    expect(text).toContain("[redacted]");
  });
});
