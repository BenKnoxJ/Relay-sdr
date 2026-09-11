import type { AgentRunStep } from "@prisma/client";
import { describe, expect, it } from "vitest";

import { MODULE_IDS } from "../../agents/research/output.schema";
import { assemblePack, corpusFromSteps, latestModules, markInsufficient, moduleWritesFromSteps, refusals, researchStateFromSteps, type ModuleWrite } from "@/lib/research/assemble";
import { createCorpus } from "@/lib/research/corpus";

import { goodPack } from "../agents/researchPack";

/**
 * Assembly (research v3 §3, §4, §6): the pack is the latest stored version of
 * each module across every run of the job, the rest listed missing; the corpus
 * is every page and snippet the job's runs stored.
 */

const accepted = (module: string, digest: string, stored: Record<string, unknown>): ModuleWrite =>
  ({ module, digest, output: { accepted: true, module, digest, stored } }) as ModuleWrite;
const refused = (module: string, digest: string, insufficient?: Record<string, unknown>): ModuleWrite =>
  ({ module, digest, output: { accepted: false, module, digest, issues: ["too thin"], ...(insufficient === undefined ? {} : { insufficient }) } }) as ModuleWrite;

const step = (name: string, output: unknown, index = 0): AgentRunStep => ({ name, output, index, kind: "tool" }) as unknown as AgentRunStep;

describe("the research state, read from the job's steps (v3.2, §10 note 28)", () => {
  const decision = (verdict: "continue" | "stop", extra: Record<string, unknown> = {}) =>
    step("decideScope", { accepted: true, verdict, reason: "r", evidenceIds: [], widenings: [], decidedAt: "2026-09-11T09:00:00Z", ...extra });

  it("is open until the scope is decided, gated after a continue, and stopped after a stop — terminally", () => {
    expect(researchStateFromSteps([])).toEqual({ state: "open" });
    expect(researchStateFromSteps([step("decideScope", { accepted: false, issues: ["x"] })])).toEqual({ state: "open" });
    expect(researchStateFromSteps([decision("continue")])).toEqual({ state: "gated" });
    const widening = { dimension: "region", text: "Wider.", scopePatch: { places: null } };
    const stopped = researchStateFromSteps([decision("continue"), decision("stop", { reason: "Too thin.", evidenceIds: ["m01-a"], widenings: [widening] }), decision("continue")]);
    expect(stopped).toEqual({ state: "stopped", stop: { reason: "Too thin.", evidenceIds: ["m01-a"], widenings: [widening], decidedAt: "2026-09-11T09:00:00Z" } });
  });
});

describe("assembly", () => {
  it("takes the latest stored version of each module, across runs", () => {
    const latest = latestModules([accepted("m01", "a", { status: "complete", body: "first" }), accepted("m01", "b", { status: "complete", body: "second" })]);
    expect(latest.m01).toMatchObject({ body: "second" });
  });

  it("never replaces a complete module with a later insufficient one, and lets a later complete one replace an insufficient", () => {
    const kept = latestModules([accepted("m03", "a", { status: "complete", body: "good" }), refused("m03", "b", { status: "insufficient", body: "bad", claims: [], issues: ["x"] })]);
    expect(kept.m03).toMatchObject({ status: "complete", body: "good" });
    const replaced = latestModules([refused("m03", "b", { status: "insufficient", body: "bad", claims: [], issues: ["x"] }), accepted("m03", "c", { status: "complete", body: "fixed" })]);
    expect(replaced.m03).toMatchObject({ status: "complete", body: "fixed" });
  });

  it("counts distinct refused writes per module", () => {
    const counts = refusals([refused("m03", "a"), refused("m03", "a"), refused("m03", "b"), accepted("m01", "c", { status: "complete" })]);
    expect(counts.get("m03")?.size).toBe(2);
    expect(counts.has("m01")).toBe(false);
  });

  it("lists what was never written as missing, and marks the pack partial", () => {
    const pack = assemblePack([accepted("m00", "a", { status: "complete" })]);
    expect(pack.partial).toBe(true);
    expect(pack.missingModules).toEqual(MODULE_IDS.filter((id) => id !== "m00"));
    const whole = goodPack({ liveFactId: "i360.product.x-y" });
    const all = assemblePack(MODULE_IDS.map((id, i) => accepted(id, String(i), (whole.modules as Record<string, Record<string, unknown>>)[id]!)));
    expect(all).toMatchObject({ partial: false, missingModules: [] });
  });

  it("reads writeModule steps and ignores anything else", () => {
    const writes = moduleWritesFromSteps([
      step("search", { hits: [] }),
      step("writeModule", { accepted: true, module: "m01", digest: "d", stored: { status: "complete" } }),
      step("writeModule", { accepted: true, module: "m99", digest: "d", stored: {} }),
      step("writeModule", { $toolError: "boom" }),
    ]);
    expect(writes.map((w) => w.module)).toEqual(["m01"]);
  });

  it("stores a module refused at ingest as insufficient, keeping only the claims that parse", () => {
    const whole = goodPack({ liveFactId: "i360.product.x-y" });
    const m01 = (whole.modules as Record<string, { claims: unknown[] }>).m01!;
    m01.claims.push({ id: "broken" });
    const out = markInsufficient(whole, "m01", ["m01: refused"]);
    const stored = (out.modules as Record<string, { status: string; claims: unknown[]; issues: string[] }>).m01!;
    expect(stored.status).toBe("insufficient");
    expect(stored.claims).toHaveLength(5);
    expect(stored.issues).toEqual(["m01: refused"]);
  });

  it("rebuilds the corpus from the job's stored searches and fetches", () => {
    const corpus = createCorpus();
    corpusFromSteps(corpus, [
      step("search", { hits: [{ title: "Backlog", url: "https://a.test/x", snippet: "the backlog doubled" }] }),
      step("fetch", { url: "https://b.test/page", markdown: "page text", strippedLines: 0 }),
      step("fetch", { url: "https://dead.test/", unreadable: true, reason: "404" }),
      step("fetch", { $toolError: "released: cap" }),
    ]);
    expect(corpus.textFor("https://a.test/x")).toContain("backlog doubled");
    expect(corpus.textFor("https://b.test/page")).toBe("page text");
    expect(corpus.unreadable.has("https://dead.test")).toBe(true);
  });
});
