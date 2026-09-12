import type { JobStatus } from "@prisma/client";

import { moduleItems, planCards, researchRawSchema, type Item } from "../../../agents/research/output.schema";

import type { CampaignPack, ResearchFailure } from "./types";

/**
 * Where a campaign's research is, from the two records that know
 * (orchestrator v2 amendment A1, item 8).
 *
 * There is no stored campaign state to go stale: research finishes on the
 * worker whenever it finishes, and a column written at Start would be wrong
 * the moment it did. So the state is read off the campaign's latest research
 * job at its current brief version and that job's `research.completed` Event,
 * every time.
 *
 * | job                   | Event                    | state                          |
 * |-----------------------|--------------------------|--------------------------------|
 * | none                  | none                     | failed, not_started            |
 * | queued or running     | none                     | researching                    |
 * | failed or cancelled   | none                     | failed, reason from its error  |
 * | done                  | none                     | failed, bad_output             |
 * | any                   | pack does not parse      | failed, bad_output             |
 * | any                   | insufficient             | stopped                        |
 * | any                   | partial                  | planReady (the pack says so)   |
 * | any                   | complete                 | planReady                      |
 *
 * The Event wins whatever the job says: the handler writes it before the job
 * is marked done, so a job still `running` with an Event has finished.
 * `insufficient` is tested before `partial`, because a stopped pack is partial
 * too: nothing after the stop was written.
 */

export type ResearchJobSnapshot = { status: JobStatus; error: string | null };

export type ResearchView =
  | { state: "researching" }
  | { state: "failed"; failure: ResearchFailure }
  | { state: "planReady"; pack: CampaignPack }
  | { state: "stopped"; pack: CampaignPack };

export function deriveResearch(job: ResearchJobSnapshot | null, event: { after: unknown } | null): ResearchView {
  if (event !== null) return fromEvent(event.after);
  if (job === null) return { state: "failed", failure: "not_started" };
  switch (job.status) {
    case "queued":
    case "running":
      return { state: "researching" };
    case "done":
      // Done with no Event is a handler that returned without recording a
      // pack: nothing a rep can read came back.
      return { state: "failed", failure: "bad_output" };
    case "failed":
    case "cancelled":
      return { state: "failed", failure: failureOf(job.error) };
  }
}

/**
 * The reason, from the job's error. The research handler writes
 * `research: <reason> — …` for the two it names (`took_too_long`,
 * `bad_output`); anything else is a failure with no reason a rep can act on,
 * and the raw error is never shown.
 */
export function failureOf(error: string | null): ResearchFailure {
  const text = error ?? "";
  if (/\btook_too_long\b/.test(text)) return "took_too_long";
  if (/\bbad_output\b/.test(text)) return "bad_output";
  return "failed";
}

/**
 * The pack on a `research.completed` Event, as the page draws it.
 *
 * Parsed with `researchRawSchema` and not `researchOutputSchema`: the output
 * schema re-runs the twelve-month stale check against today, so a pack that
 * was valid when it was stored would start failing as it aged.
 *
 * On a stop, the evidence it cites is looked up among the pack's own m00 and
 * m01 items by id. Nothing is copied or invented: ingest already refused a
 * stop citing anything else, so every id resolves.
 */
function fromEvent(after: unknown): ResearchView {
  const raw = after !== null && typeof after === "object" ? (after as { pack?: unknown }).pack : undefined;
  const parsed = researchRawSchema.safeParse(raw);
  if (!parsed.success) return { state: "failed", failure: "bad_output" };
  const pack = parsed.data;
  const view = planCards(pack);
  if (pack.insufficient === undefined) return { state: "planReady", pack: view };

  const byId = new Map([...moduleItems(pack, "m00"), ...moduleItems(pack, "m01")].map((item) => [item.id, item]));
  const stopEvidence = pack.insufficient.evidenceIds
    .map((id) => byId.get(id))
    .filter((item): item is Item => item !== undefined);
  return { state: "stopped", pack: { ...view, stopEvidence } };
}
