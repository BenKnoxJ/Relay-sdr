import { createHash } from "node:crypto";

import type { SearchInput } from "../types";

/**
 * The part of a research tool call that identifies it, hashed.
 *
 * Two things read it: `withReplay`, which folds it into the per-job replay key
 * (`sha(orgId, jobId, runKind, toolName, discriminator)`), and the mock
 * services, which file a recorded response under it. Kept here, on the
 * services side, so the recording that a live call wrote is the recording the
 * mock finds — one function, both sides.
 */

export function searchDiscriminator(input: SearchInput): string {
  return createHash("sha256")
    .update(JSON.stringify([input.query.trim().toLowerCase(), input.region.toUpperCase(), input.recencyMonths ?? null]))
    .digest("hex");
}

export function fetchDiscriminator(url: string): string {
  return createHash("sha256").update(url.trim()).digest("hex");
}
