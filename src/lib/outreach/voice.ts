import { readFileSync } from "node:fs";
import path from "node:path";

import { z } from "zod";

import { REGISTERS, type OutreachInput } from "../../../agents/outreach/input.schema";
import { agentsDir } from "@/lib/agents/definitions";

/**
 * The default voice (voice round, 28 Sep 2026): the hand a rep with no samples of their own writes in.
 *
 * Vendored into `agents/outreach/voice/` because Relay deploys on its own and the repository is public: the
 * style profile (`style.md`, the rep's "how I write" default) and the approved messages as ask-and-wrote pairs
 * (`anchors.json`), every name and firm in them made up. The writer continues these rather than imitating a
 * rule list.
 */

const anchorsFileSchema = z.object({
  source: z.string(),
  anchors: z.array(z.object({ register: z.enum(REGISTERS), ask: z.string().min(1).max(600), wrote: z.string().min(1).max(1500) }).strict()).min(1).max(8),
});

export type DefaultVoice = { howIWrite: string; anchors: NonNullable<OutreachInput["voice"]["anchors"]> };

let cached: DefaultVoice | null = null;

export function loadDefaultVoice(baseDir: string = agentsDir()): DefaultVoice {
  if (cached !== null && baseDir === agentsDir()) return cached;
  const dir = path.join(baseDir, "outreach", "voice");
  const { anchors } = anchorsFileSchema.parse(JSON.parse(readFileSync(path.join(dir, "anchors.json"), "utf8")));
  const voice = { howIWrite: readFileSync(path.join(dir, "style.md"), "utf8").trim().slice(0, 2000), anchors };
  if (baseDir === agentsDir()) cached = voice;
  return voice;
}

/**
 * The voice the writer is given. The rep's own samples when they have any (§15 resolution 1: the eight most
 * recent), and the default anchors only when they have none. Their own "how I write" note wins; the default
 * style profile stands in when it is empty.
 */
export function voiceInputOf(rep: { samples: readonly { text: string }[]; howIWrite: string }, fallback: DefaultVoice): OutreachInput["voice"] {
  const email = rep.samples.slice(-8).map((sample) => sample.text);
  const howIWrite = (rep.howIWrite.trim() === "" ? fallback.howIWrite : rep.howIWrite).slice(0, 2000);
  return email.length > 0 ? { email, linkedin: [], howIWrite } : { email, linkedin: [], howIWrite, anchors: fallback.anchors };
}
