import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

import { decodeTokenKey, env } from "@/lib/env";

/**
 * Token envelope encryption (master doc §24).
 *
 * A rep's connected-account tokens are the most dangerous thing Relay holds: a
 * refresh token is a standing key to that person's mailbox and CRM. They are
 * stored as an AES-256-GCM envelope under `TOKEN_ENC_KEY`, with a fresh random
 * 12-byte IV per call, so the same token never encrypts to the same bytes twice
 * and a row edited in the database fails to decrypt rather than decrypting to
 * something else.
 *
 * Blob format: `base64(iv).base64(tag).base64(ciphertext)`.
 *
 * The key is never logged and never included in an error message.
 */

const IV_BYTES = 12;
const TAG_BYTES = 16;

function key(explicit?: string): Buffer {
  const raw = explicit ?? env().TOKEN_ENC_KEY;
  if (raw === undefined) {
    throw new Error("TOKEN_ENC_KEY is not configured, so no token can be encrypted or read");
  }
  return decodeTokenKey(raw);
}

export function encryptToken(plain: string, encKey?: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key(encKey), iv);
  const ciphertext = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return [
    iv.toString("base64"),
    cipher.getAuthTag().toString("base64"),
    ciphertext.toString("base64"),
  ].join(".");
}

export function decryptToken(blob: string, encKey?: string): string {
  const parts = blob.split(".");
  if (parts.length !== 3) throw new Error("malformed token blob");
  const [ivB64, tagB64, dataB64] = parts as [string, string, string];
  const iv = Buffer.from(ivB64, "base64");
  const tag = Buffer.from(tagB64, "base64");
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) throw new Error("malformed token blob");

  const decipher = createDecipheriv("aes-256-gcm", key(encKey), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([
    decipher.update(Buffer.from(dataB64, "base64")),
    decipher.final(),
  ]).toString("utf8");
}
