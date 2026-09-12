import { describe, expect, it } from "vitest";

import { deriveResearch, failureOf } from "@/lib/campaigns/derive";

import { completePack, partialPack, stoppedPack } from "./campaignPacks";

/**
 * Where a campaign's research is (orchestrator v2 amendment A1, item 8): read
 * off its latest research job and that job's Event, never stored. One case
 * per row of the table in `src/lib/campaigns/derive.ts`.
 */

const job = (status: "queued" | "running" | "done" | "failed" | "cancelled", error: string | null = null) => ({
  status,
  error,
});
const event = (pack: unknown) => ({ after: { jobId: "job_1", pack } });

describe("deriveResearch", () => {
  it("is failed, not started, when there is no research job at all", () => {
    expect(deriveResearch(null, null)).toEqual({ state: "failed", failure: "not_started" });
  });

  it("is researching while the job is queued or running, retry backoff included", () => {
    expect(deriveResearch(job("queued"), null)).toEqual({ state: "researching" });
    expect(deriveResearch(job("queued", "lease expired"), null)).toEqual({ state: "researching" });
    expect(deriveResearch(job("running"), null)).toEqual({ state: "researching" });
  });

  it("is failed with the job's own reason when it failed, and never shows the raw error", () => {
    expect(deriveResearch(job("failed", "research: took_too_long — a rail was reached"), null)).toEqual({
      state: "failed",
      failure: "took_too_long",
    });
    expect(deriveResearch(job("failed", "research: bad_output — the pack does not validate"), null)).toEqual({
      state: "failed",
      failure: "bad_output",
    });
    expect(deriveResearch(job("failed", "Can't reach database server"), null)).toEqual({ state: "failed", failure: "failed" });
    expect(deriveResearch(job("cancelled"), null)).toEqual({ state: "failed", failure: "failed" });
  });

  it("is failed, bad output, when the job is done and left no pack, or a pack that does not parse", () => {
    expect(deriveResearch(job("done"), null)).toEqual({ state: "failed", failure: "bad_output" });
    expect(deriveResearch(job("done"), event({ modules: {} }))).toEqual({ state: "failed", failure: "bad_output" });
    expect(deriveResearch(job("done"), { after: null })).toEqual({ state: "failed", failure: "bad_output" });
  });

  it("is plan ready on a complete pack, with the plan cards built from it", () => {
    const view = deriveResearch(job("done"), event(completePack()));
    expect(view.state).toBe("planReady");
    if (view.state !== "planReady") return;
    expect(view.pack.partial).toBe(false);
    expect(view.pack.missingModules).toEqual([]);
    expect(view.pack.archetypes).toHaveLength(3);
    expect(view.pack.insufficient).toBeUndefined();
    expect(view.pack.chosenArchetypeId).toBeDefined();
  });

  it("is plan ready on a partial pack, and the pack says what is missing", () => {
    const view = deriveResearch(job("done"), event(partialPack()));
    expect(view.state).toBe("planReady");
    if (view.state !== "planReady") return;
    expect(view.pack.partial).toBe(true);
    expect(view.pack.missingModules).toContain("m04");
    expect(view.pack.missingModules).not.toContain("m03");
  });

  it("is stopped on an insufficient pack, although that pack is partial too", () => {
    const pack = stoppedPack();
    expect(pack.partial).toBe(true);

    const view = deriveResearch(job("done"), event(pack));
    expect(view.state).toBe("stopped");
    if (view.state !== "stopped") return;
    expect(view.pack.insufficient?.widenings.map((w) => w.dimension)).toEqual(["region", "region", "sector"]);
  });

  it("resolves every item the stop cites from the pack's own m00 and m01, and invents none", () => {
    const pack = stoppedPack();
    const view = deriveResearch(job("done"), event(pack));
    if (view.state !== "stopped") throw new Error("expected a stop");

    const cited = pack.insufficient!.evidenceIds;
    expect(cited).toHaveLength(9);
    expect(view.pack.stopEvidence?.map((item) => item.id)).toEqual(cited);
    for (const item of view.pack.stopEvidence ?? []) {
      expect(item.confidence).toMatch(/^(strong|moderate|weak|speculative)$/);
    }
  });

  it("takes the Event over the job: a job still running with an Event has finished", () => {
    expect(deriveResearch(job("running"), event(completePack())).state).toBe("planReady");
    expect(deriveResearch(job("failed", "research: took_too_long"), event(stoppedPack())).state).toBe("stopped");
  });
});

describe("failureOf", () => {
  it("names the two reasons research writes, and calls anything else a failure", () => {
    expect(failureOf("research: took_too_long — x")).toBe("took_too_long");
    expect(failureOf("research: bad_output — x")).toBe("bad_output");
    expect(failureOf("research: bad input (brief.region)")).toBe("failed");
    expect(failureOf(null)).toBe("failed");
  });
});
