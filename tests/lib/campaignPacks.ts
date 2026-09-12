import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import { researchRawSchema, type PackShape } from "../../agents/research/output.schema";
import { EMPTY_SCOPE } from "@/lib/campaigns/start";
import type { BriefFields } from "@/lib/campaigns/types";
import { loadFacts } from "@/lib/facts/load";

import { goodPack } from "../agents/researchPack";

/**
 * Research results to derive campaign screens from, all real contract data:
 *
 *   * complete: `goodPack()`, the complete v3 pack the research runtime's own
 *     tests build (no committed live pack passes today's v3.2 rules whole);
 *   * partial: the signed brief B v3.2 run (`research-b-telephony-channel-v3.2.json`);
 *   * insufficient: the signed brief C v3.2 rerun, the regression stop
 *     (`research-c-thin-vets-v3.2-rerun.json`).
 *
 * Not a test file: the node project collects only `*.test.ts`.
 */

const FIXTURES = path.resolve(import.meta.dirname, "..", "..", "fixtures", "research");

type ResearchFixture = { input: { brief: Record<string, unknown> }; output: unknown };

function fixture(name: string): ResearchFixture {
  return JSON.parse(readFileSync(path.join(FIXTURES, name), "utf8")) as ResearchFixture;
}

function packOf(fixtureOutput: unknown): PackShape {
  const raw = (fixtureOutput as { pack?: unknown } | null)?.pack ?? fixtureOutput;
  return researchRawSchema.parse(raw);
}

export function completePack(): PackShape {
  const liveFactId = loadFacts("insights360", 2).file.facts.find((fact) => fact.status === "live")!.id;
  return { ...goodPack({ liveFactId }), outcome: "complete" };
}

export function partialPack(): PackShape {
  return packOf(fixture("research-b-telephony-channel-v3.2.json").output);
}

export function stoppedPack(): PackShape {
  return packOf(fixture("research-c-thin-vets-v3.2-rerun.json").output);
}

/** The brief each signed run was given. */
export const partialBrief = () => fixture("research-b-telephony-channel-v3.2.json").input.brief;
export const stoppedBrief = () => fixture("research-c-thin-vets-v3.2-rerun.json").input.brief;

/** A Start card as the rep confirmed it, nothing in who exactly. */
export function briefFields(over: Partial<BriefFields> = {}): BriefFields {
  return {
    product: "Insights360",
    motion: "direct",
    who: "Practice owners at independent vets in Orkney",
    region: "GB",
    howMany: 10,
    weeks: 3,
    channels: ["email"],
    scope: EMPTY_SCOPE,
    existingCustomers: "",
    ...over,
  };
}

/** What `campaigns.create` is sent: a fresh press of Start. */
export function startInput(over: Partial<BriefFields> = {}, startRequestId: string = randomUUID()) {
  return { startRequestId, brief: briefFields(over) };
}
