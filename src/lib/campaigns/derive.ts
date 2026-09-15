import type { JobStatus } from "@prisma/client";

import { moduleItems, planCards, researchRawSchema, type Item, type PackShape } from "../../../agents/research/output.schema";

import { haltSchema, leadgenOutputSchema, type Halt, type Pick } from "../../../agents/leadgen/output.schema";

import { overviewOf } from "./overview";
import { executablePlayCount, playFactsOf } from "./plays";
import { leadGenRetryable } from "./retry";
import type { LeadGenResult } from "./stage";
import type { CampaignOverview, CampaignPack, ResearchFailure } from "./types";

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
 * | any                   | no play can be searched  | failed, no_play                |
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
  | { state: "planReady"; pack: CampaignPack; overview: CampaignOverview }
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
  const pack = storedPack(after);
  if (pack === null) return { state: "failed", failure: "bad_output" };
  if (pack.insufficient === undefined) {
    // A plan is something the rep can confirm: at least one play research
    // ranked has a kind of buyer the pack describes and a search recipe for it.
    if (executablePlayCount(playFactsOf(pack)) === 0) return { state: "failed", failure: "no_play" };
    return { state: "planReady", pack: planCards(pack), overview: overviewOf(pack) };
  }
  const view = planCards(pack);

  const byId = new Map([...moduleItems(pack, "m00"), ...moduleItems(pack, "m01")].map((item) => [item.id, item]));
  const stopEvidence = pack.insufficient.evidenceIds
    .map((id) => byId.get(id))
    .filter((item): item is Item => item !== undefined);
  return { state: "stopped", pack: { ...view, stopEvidence } };
}

/** The pack on a `research.completed` Event as the screens read it (`researchRawSchema`), or null when there is none they can read. */
export function storedPack(after: unknown): PackShape | null {
  const raw = after !== null && typeof after === "object" ? (after as { pack?: unknown }).pack : undefined;
  const parsed = researchRawSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/**
 * Where finding people is, once a version is confirmed (lead gen v2.1 §11,
 * extending orchestrator A1 item 8): read off the latest lead gen job at the
 * version and that job's result Event, never stored.
 *
 * | job                 | result Event     | state            |
 * |---------------------|------------------|------------------|
 * | queued or running   | none             | findingPeople    |
 * | any                 | leadgen.picked   | peopleFound      |
 * | any                 | leadgen.halted   | peopleNeedsYou   |
 * | failed or cancelled | none             | peopleNeedsYou   |
 * | done, or none       | none             | peopleNeedsYou   |
 */
export type LeadGenState =
  | { state: "findingPeople" }
  | { state: "peopleFound"; pick: Pick }
  | {
      state: "peopleNeedsYou";
      reason: Halt["reason"] | "failed";
      field?: string;
      term?: string;
      choices: string[];
      /** Try again is offered: a busy provider, a timeout, or a failed job. */
      retryable: boolean;
      /** The rep can choose an industry and search with it. */
      choosable: boolean;
    };

/**
 * Where Reveal emails is, once pressed (lead gen v2.1 §11): read off the
 * reveal job and its `leadgen.revealed` Event, never stored.
 *
 * | job                         | Event             | state                   |
 * |-----------------------------|-------------------|-------------------------|
 * | any                         | leadgen.revealed  | peopleReady             |
 * | queued or running           | none              | revealing               |
 * | failed, cancelled, done, or none | none         | revealing, stopped      |
 */
export type RevealView = { state: "revealing"; stopped: boolean } | { state: "peopleReady" };

export function deriveReveal(job: ResearchJobSnapshot | null, result: { kind: string } | null): RevealView {
  if (result?.kind === "leadgen.revealed") return { state: "peopleReady" };
  if (job !== null && (job.status === "queued" || job.status === "running")) return { state: "revealing", stopped: false };
  return { state: "revealing", stopped: true };
}

export function deriveLeadGen(job: ResearchJobSnapshot | null, result: { kind: string; after: unknown } | null): LeadGenState {
  const output = result !== null && result.after !== null && typeof result.after === "object" ? (result.after as { output?: unknown }).output : undefined;
  const failed = (retryable: boolean): LeadGenState => ({ state: "peopleNeedsYou", reason: "failed", choices: [], retryable, choosable: false });
  if (result?.kind === "leadgen.picked") {
    const parsed = leadgenOutputSchema.safeParse(output);
    return parsed.success && parsed.data.phase === "pick" ? { state: "peopleFound", pick: parsed.data } : failed(false);
  }
  if (result?.kind === "leadgen.halted") {
    const parsed = haltSchema.safeParse(output);
    if (!parsed.success) return failed(false);
    const halt = parsed.data;
    return {
      state: "peopleNeedsYou",
      reason: halt.reason,
      ...(halt.field === undefined ? {} : { field: halt.field }),
      ...(halt.term === undefined ? {} : { term: halt.term }),
      choices: halt.choices ?? [],
      retryable: halt.reason === "provider_busy" || halt.reason === "took_too_long",
      choosable: halt.reason === "choose_industry" && (halt.choices ?? []).length > 0,
    };
  }
  if (job === null) return failed(false);
  switch (job.status) {
    case "queued":
    case "running":
      return { state: "findingPeople" };
    case "failed":
    case "cancelled":
      return failureOf(job.error) === "took_too_long"
        ? { state: "peopleNeedsYou", reason: "took_too_long", choices: [], retryable: leadGenRetryable(job, null), choosable: false }
        : failed(leadGenRetryable(job, null));
    case "done":
      return failed(false);
  }
}

/** A lead gen result Event as the stage derivation reads it: people picked, a halt, or a result Relay could not read. */
export function leadGenResultOf(result: { kind: string; after: unknown } | null): LeadGenResult | null {
  if (result === null) return null;
  const view = deriveLeadGen(null, result);
  if (view.state === "peopleFound") return { kind: "picked" };
  if (view.state === "peopleNeedsYou" && view.reason !== "failed") return { kind: "halted", reason: view.reason, choices: view.choices.length };
  return { kind: "unreadable" };
}
