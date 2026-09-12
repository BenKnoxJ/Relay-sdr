import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { agentsDir } from "@/lib/agents/definitions";
import { factsFileSchema, toProductFacts, type FactsFile } from "@/lib/facts/schema";
import type { ProductFacts } from "../../../agents/research/input.schema";

/**
 * Load a facts file from `facts/<product>.v<version>.json` and hash it.
 *
 * Beside `agents/`, found the same way: the nearest `package.json` above this
 * module. A deploy that ships `dist/` ships `facts/` next to it, exactly as it
 * ships `agents/` (Task 13).
 */

export type LoadedFacts = {
  /** Where it was read from, for the record. */
  path: string;
  file: FactsFile;
  /** The agents' view of the same file. */
  facts: ProductFacts;
  /** sha256 over the canonical rendering. Pinned in `ProductFactsVersion`. */
  hash: string;
  /** `true` until the product owner signs the file. Named on every run that cites it. */
  draft: boolean;
};

export function factsDir(): string {
  return path.join(path.dirname(agentsDir()), "facts");
}

/**
 * The hash, over a canonical rendering rather than the bytes on disk.
 *
 * Keys sorted at every depth, no whitespace: two files that differ only in key
 * order or formatting are the same facts and hash the same, and a fact whose
 * `claim` changed by one character hashes differently. Whitespace inside a
 * claim is content and is kept.
 */
export function factsHash(file: FactsFile): string {
  return createHash("sha256").update(canonical(file)).digest("hex");
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function factsPath(product: string, version: number): string {
  if (!/^[a-z0-9-]+$/.test(product)) throw new Error(`loadFacts: product ${JSON.stringify(product)} is not a plain slug`);
  if (!Number.isInteger(version) || version < 1) throw new Error(`loadFacts: version ${version} is not a positive integer`);
  return path.join(factsDir(), `${product}.v${version}.json`);
}

export function loadFacts(product: string, version: number): LoadedFacts {
  const file = factsPath(product, version);
  if (!existsSync(file)) {
    throw new Error(`loadFacts: no facts file at ${file} — the facts file is code and ships with the repository`);
  }
  const parsed = factsFileSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
  if (!parsed.success) {
    throw new Error(
      `loadFacts: ${file} does not parse: ${parsed.error.issues.map((issue) => `${issue.path.join(".") || "$"}: ${issue.message}`).join("; ")}`,
    );
  }
  if (parsed.data.product !== product || parsed.data.version !== version) {
    throw new Error(
      `loadFacts: ${file} says it is ${parsed.data.product} v${parsed.data.version}, not ${product} v${version}`,
    );
  }
  return {
    path: file,
    file: parsed.data,
    facts: toProductFacts(parsed.data),
    hash: factsHash(parsed.data),
    draft: parsed.data.status !== "signed",
  };
}
