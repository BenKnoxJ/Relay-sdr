import { randomBytes } from "node:crypto";

import { describe, it, expect, afterEach } from "vitest";

import { encryptToken, decryptToken } from "@/lib/services/crypto";
import { resetEnv } from "@/lib/env";

const KEY = randomBytes(32).toString("base64");
const OTHER_KEY = randomBytes(32).toString("base64");

/** Swap a base64 blob's middle section (the tag) for a different one. */
function withTag(blob: string, tag: string): string {
  const [iv, , data] = blob.split(".");
  return [iv, tag, data].join(".");
}

describe("encryptToken / decryptToken", () => {
  afterEach(() => {
    delete process.env.TOKEN_ENC_KEY;
    resetEnv();
  });

  it("round trips a token", () => {
    expect(decryptToken(encryptToken("refresh-token-value", KEY), KEY)).toBe(
      "refresh-token-value",
    );
  });

  it("round trips an empty string and non-ASCII text", () => {
    expect(decryptToken(encryptToken("", KEY), KEY)).toBe("");
    expect(decryptToken(encryptToken("トークン ✓", KEY), KEY)).toBe("トークン ✓");
  });

  it("never writes the token in the clear", () => {
    expect(encryptToken("refresh-token-value", KEY)).not.toContain("refresh-token-value");
  });

  it("uses a fresh IV per call, so the same token encrypts differently each time", () => {
    const blobs = new Set(Array.from({ length: 8 }, () => encryptToken("same", KEY)));
    expect(blobs.size).toBe(8);
    const ivs = new Set([...blobs].map((blob) => blob.split(".")[0]));
    expect(ivs.size).toBe(8);
  });

  it("writes iv.tag.ciphertext, with a 12-byte IV and a 16-byte tag", () => {
    const parts = encryptToken("value", KEY).split(".");
    expect(parts).toHaveLength(3);
    expect(Buffer.from(parts[0]!, "base64")).toHaveLength(12);
    expect(Buffer.from(parts[1]!, "base64")).toHaveLength(16);
  });

  it("refuses a tampered tag rather than returning wrong plaintext", () => {
    const blob = encryptToken("value", KEY);
    expect(() => decryptToken(withTag(blob, randomBytes(16).toString("base64")), KEY)).toThrow();
  });

  it("refuses a truncated tag, at the crypto API and not only at our own check", () => {
    // Node's GCM accepts a short tag unless `authTagLength` is pinned — it
    // only warns — and a truncated tag is a forgery route. `decryptToken`'s
    // own length check fires first today; this asserts the refusal, so that a
    // later edit reordering that check cannot quietly open the door.
    const blob = encryptToken("value", KEY);
    const [, tag] = blob.split(".");
    const truncated = Buffer.from(tag!, "base64").subarray(0, 12).toString("base64");
    expect(() => decryptToken(withTag(blob, truncated), KEY)).toThrow(/malformed token blob/);
  });

  it("refuses tampered ciphertext", () => {
    const [iv, tag, data] = encryptToken("value", KEY).split(".");
    const bytes = Buffer.from(data!, "base64");
    bytes[0] = bytes[0]! ^ 0xff;
    expect(() => decryptToken([iv, tag, bytes.toString("base64")].join("."), KEY)).toThrow();
  });

  it("refuses a blob encrypted under another key", () => {
    expect(() => decryptToken(encryptToken("value", KEY), OTHER_KEY)).toThrow();
  });

  it("refuses a malformed blob", () => {
    for (const blob of ["", "not-a-blob", "a.b", "a.b.c.d", "a.b.c"]) {
      expect(() => decryptToken(blob, KEY), blob).toThrow(/malformed token blob/);
    }
  });

  it("refuses a key that does not decode to 32 bytes", () => {
    const short = randomBytes(31).toString("base64");
    expect(() => encryptToken("value", short)).toThrow(/32 bytes/);
    expect(() => decryptToken(encryptToken("value", KEY), short)).toThrow(/32 bytes/);
  });

  it("refuses a key that is not base64", () => {
    expect(() => encryptToken("value", "not a key!!!")).toThrow(/base64/);
  });

  it("falls back to TOKEN_ENC_KEY from the environment", () => {
    process.env.TOKEN_ENC_KEY = KEY;
    resetEnv();
    expect(decryptToken(encryptToken("value"))).toBe("value");
  });

  it("says so when no key is configured at all", () => {
    delete process.env.TOKEN_ENC_KEY;
    resetEnv();
    expect(() => encryptToken("value")).toThrow(/TOKEN_ENC_KEY/);
  });
});
