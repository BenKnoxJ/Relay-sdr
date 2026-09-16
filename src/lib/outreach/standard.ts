import { readFileSync } from "node:fs";
import path from "node:path";

import { z } from "zod";

import { standardSchema } from "../../../agents/outreach/input.schema";
import { agentsDir } from "@/lib/agents/definitions";

/**
 * The message standard (master §15): the product owner's one-page living
 * standard, versioned in the repository beside the outreach definition
 * (`agents/outreach/standard.json`). The rules and exemplars go to the writer;
 * the tell list goes to the writer as a list and is gated in code (v2.1 §6).
 */

const fileSchema = standardSchema.extend({ note: z.string().optional() });

export type MessageStandard = z.infer<typeof standardSchema>;

let cached: MessageStandard | null = null;

export function loadStandard(baseDir: string = agentsDir()): MessageStandard {
  if (cached !== null && baseDir === agentsDir()) return cached;
  const parsed = fileSchema.parse(JSON.parse(readFileSync(path.join(baseDir, "outreach", "standard.json"), "utf8")));
  const { note: _note, ...standard } = parsed;
  if (baseDir === agentsDir()) cached = standard;
  return standard;
}
