import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { z } from "zod";

import { agentsDir } from "@/lib/agents/definitions";

/**
 * The product knowledge set: what the research agent may read about the
 * product beyond the facts file (research v3 §4 `knowledge(article)`).
 *
 * `knowledge/<product>/v<version>/` beside `agents/` and `facts/`: a scrubbed
 * copy of the product's wiki articles (fleet codenames, internal paths and
 * personal names replaced; content otherwise verbatim), a `manifest.json`
 * naming them, and nothing else. It is code: versioned, hashed on every run
 * that reads it, shipped with the repository, so the agent reads what the
 * fleet's researcher reads and Relay still runs without the VPS (master §10).
 * Updating it is a commit and a new version.
 */

export const KNOWLEDGE_ARTICLES = [
  "overview",
  "roadmap",
  "architecture",
  "integrations",
  "icp",
  "competitors",
  "brand-voice",
  "decisions",
  "known-issues",
] as const;
export type KnowledgeArticle = (typeof KNOWLEDGE_ARTICLES)[number];

export const knowledgeManifestSchema = z
  .object({
    product: z.string().regex(/^[a-z0-9-]+$/),
    version: z.number().int().positive(),
    copiedAt: z.string().datetime(),
    source: z.string().min(1),
    articles: z.array(z.enum(KNOWLEDGE_ARTICLES)).min(1),
  })
  .strict();
export type KnowledgeManifest = z.infer<typeof knowledgeManifestSchema>;

export type LoadedKnowledge = {
  path: string;
  manifest: KnowledgeManifest;
  /** Article name → markdown text. */
  articles: ReadonlyMap<KnowledgeArticle, string>;
  /** sha256 over the manifest and every article, in manifest order. */
  hash: string;
};

export function knowledgeDir(): string {
  return path.join(path.dirname(agentsDir()), "knowledge");
}

export function knowledgePath(product: string, version: number): string {
  if (!/^[a-z0-9-]+$/.test(product)) throw new Error(`loadKnowledge: product ${JSON.stringify(product)} is not a plain slug`);
  if (!Number.isInteger(version) || version < 1) throw new Error(`loadKnowledge: version ${version} is not a positive integer`);
  return path.join(knowledgeDir(), product, `v${version}`);
}

export function knowledgeHash(manifest: KnowledgeManifest, articles: ReadonlyMap<string, string>): string {
  const hash = createHash("sha256");
  hash.update(JSON.stringify({ product: manifest.product, version: manifest.version, articles: manifest.articles }));
  for (const name of manifest.articles) hash.update(`\n--- ${name}\n${articles.get(name) ?? ""}`);
  return hash.digest("hex");
}

export function loadKnowledge(product: string, version: number): LoadedKnowledge {
  const dir = knowledgePath(product, version);
  const manifestFile = path.join(dir, "manifest.json");
  if (!existsSync(manifestFile)) {
    throw new Error(`loadKnowledge: no knowledge set at ${dir} — the knowledge set is code and ships with the repository`);
  }
  const parsed = knowledgeManifestSchema.safeParse(JSON.parse(readFileSync(manifestFile, "utf8")));
  if (!parsed.success) {
    throw new Error(
      `loadKnowledge: ${manifestFile} does not parse: ${parsed.error.issues.map((issue) => `${issue.path.join(".") || "$"}: ${issue.message}`).join("; ")}`,
    );
  }
  if (parsed.data.product !== product || parsed.data.version !== version) {
    throw new Error(`loadKnowledge: ${manifestFile} says it is ${parsed.data.product} v${parsed.data.version}, not ${product} v${version}`);
  }
  const articles = new Map<KnowledgeArticle, string>();
  for (const name of parsed.data.articles) {
    const file = path.join(dir, `${name}.md`);
    if (!existsSync(file)) throw new Error(`loadKnowledge: ${manifestFile} names ${name} but ${file} is missing`);
    articles.set(name, readFileSync(file, "utf8"));
  }
  return { path: dir, manifest: parsed.data, articles, hash: knowledgeHash(parsed.data, articles) };
}

/**
 * What a scrubbed article must not contain: the fleet's codenames as names,
 * this VPS's paths, and the owner's name. Case-sensitive on the codenames so
 * that ordinary English ("a buying signal", "critical", the Neon database)
 * stays; the lower-case spellings a copy leaves behind are named on their own:
 * an `author:` line and a handoff filename (`signal-<topic>.md`).
 * `tests/knowledge/load.test.ts` runs it over every shipped file.
 */
export const KNOWLEDGE_SCRUB =
  /\b(Signal|Canvas|Prism|Pitch|Forge|Critic|Sentinel|Scribe|Glitch|Vector)\b|\bauthor:\s*(signal|canvas|prism|pitch|forge|vector)\b|\b(signal|canvas|prism|pitch|forge|vector)-[a-z0-9-]+\.md\b|~\/(vault|wiki|agents|projects)|(?<![\w.:/-])\/home\/[a-z_][a-z0-9_-]*\/|\bBenny\b/;
