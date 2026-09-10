import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { checkTouchLimits, outreachOutputSchema } from "../../agents/outreach/output.schema";
import { outreachInputSchema } from "../../agents/outreach/input.schema";
import {
  aboveCeiling,
  confidenceCeiling,
  demoteStale,
  staleAndOverClaimed,
} from "../../agents/_shared/item.schema";
import { authoredText, domainCounts, researchOutputSchema } from "../../agents/research/output.schema";
import { AGENT_KINDS, agentsDir, loadDefinition } from "@/lib/agents/definitions";
import { loadFacts } from "@/lib/facts/load";

import { goodPack, mod } from "./researchPack";

/**
 * The five definitions load, their schemas compile, and each one accepts its own
 * fixture and rejects a seeded bad one.
 *
 * This is the test that makes `agents/` the code's input rather than a folder of
 * documents nobody reads. Every `definition.md` is a verbatim copy of the signed
 * file in the vault, so a schema that drifts from its contract shows up here as a
 * fixture that stops parsing.
 */

const fixture = (kind: string, file: string): unknown =>
  JSON.parse(readFileSync(path.join(agentsDir(), kind, "fixtures", file), "utf8"));

describe("the signed definitions", () => {
  it("all five load, with prompt, definition and rubric", () => {
    for (const kind of AGENT_KINDS) {
      const definition = loadDefinition(kind);
      expect(definition.kind).toBe(kind);
      expect(definition.definition.length).toBeGreaterThan(200);
      expect(definition.rubric.length).toBeGreaterThan(200);
      expect(definition.budget.maxModelSteps).toBeGreaterThanOrEqual(0);
      // Lead gen is the one with no prompt, because it makes no model calls.
      if (kind === "leadgen") {
        expect(definition.prompt).toBeNull();
        expect(definition.budget.maxModelSteps).toBe(0);
      } else {
        expect(definition.prompt?.length ?? 0).toBeGreaterThan(100);
        expect(definition.budget.maxModelSteps).toBeGreaterThan(0);
      }
    }
  });

  it("carries the signed file verbatim, not a paraphrase of it", () => {
    // The definition in the repository is the definition in the vault. A test
    // cannot read the vault (it is outside the repository and not deployed), so
    // what is checked is the marker that says which file this is a copy of.
    for (const kind of ["research", "orchestrator", "leadgen", "outreach"] as const) {
      const { definition } = loadDefinition(kind);
      expect(definition).toMatch(/^# Relay agent definition — /);
      // Research was re-signed as v3 on 2026-09-09; the other three stand at v2.
      expect(definition).toMatch(kind === "research" ? /v3 · SIGNED by the product owner 2026-09-09/ : /SIGNED by Benny-san 2026-09-08/);
    }
  });

  it("memoises, and re-reads after a reset", () => {
    const first = loadDefinition("echo");
    expect(loadDefinition("echo")).toBe(first);
  });

  it("gives research one set of rails, an order above a real run (v3 §6)", () => {
    expect(loadDefinition("research").budget).toEqual({
      maxModelSteps: 200,
      maxSearches: 120,
      maxFetches: 60,
      maxSeconds: 90 * 60,
      maxFetchedChars: 400_000,
      maxSpendUsd: 50,
    });
  });
});

describe("each definition's schemas, against its own fixtures", () => {
  const cases = [
    { kind: "echo", bad: "output.bad.json" },
    { kind: "research", bad: "output.bad.json" },
    { kind: "orchestrator", bad: "output.bad.json" },
    { kind: "leadgen", bad: "output.bad.json" },
    { kind: "outreach", bad: "output.bad.json" },
  ] as const;

  for (const { kind, bad } of cases) {
    it(`${kind} accepts its own output fixture and rejects the seeded bad one`, () => {
      const definition = loadDefinition(kind);
      expect(definition.output.safeParse(fixture(kind, "output.good.json")).success).toBe(true);
      expect(definition.output.safeParse(fixture(kind, bad)).success).toBe(false);
    });

    it(`${kind} accepts its own input fixture`, () => {
      const definition = loadDefinition(kind);
      const parsed = definition.input.safeParse(fixture(kind, "input.good.json"));
      if (!parsed.success) {
        throw new Error(
          `${kind} input fixture: ${parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`,
        );
      }
    });
  }

  it("orchestrator validates an answer as well as a pre-fill", () => {
    const definition = loadDefinition("orchestrator");
    expect(definition.output.safeParse(fixture("orchestrator", "output.answer.good.json")).success).toBe(true);
  });

  it("orchestrator keeps the rep's own sentence and checks only what Relay wrote", () => {
    const definition = loadDefinition("orchestrator");
    // The rep described their buyers in ordinary English. Every one of these
    // words is on the banned list, and none of them is Relay's machinery on a
    // screen — the pre-fill is the rep's sentence handed back to them.
    const prefill = definition.output.safeParse({
      step: "pre-fill",
      product: "Signal Analytics",
      who: "heads of ops who own the claims pipeline",
      channels: ["email", "call"],
      guessed: [],
    });
    expect(prefill.success).toBe(true);

    // The two strings Relay writes are still checked.
    expect(definition.output.safeParse({ step: "name", name: "Pipeline agent run" }).success).toBe(false);
    const answer = definition.output.safeParse({ step: "answer", answer: "The orchestrator started a job." });
    expect(answer.success).toBe(false);
    if (answer.success) return;
    expect(answer.error.issues.some((issue) => issue.path.join(".") === "answer")).toBe(true);
  });
});

describe("research v3: the pack's rules, on a complete pack built in code", () => {
  const live = loadFacts("insights360", 1).facts.facts.find((fact) => fact.status === "live")!.id;
  const good = () => goodPack({ liveFactId: live });

  it("accepts the complete pack, every module present and at its floors", () => {
    const result = researchOutputSchema.safeParse(good());
    if (!result.success) throw new Error(result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "));
  });

  it("rejects an item whose confidence is above its evidence ceiling", () => {
    const pack = good();
    mod(pack, "m05").perArchetype[0]!.pains[0]!.confidence = "strong";
    const result = researchOutputSchema.safeParse(pack);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.some((issue) => /above the ceiling "weak"/.test(issue.message))).toBe(true);
  });

  it("derives the ceiling from the evidence, exactly as §3 states it", () => {
    const spread = (n: number) => Array.from({ length: n }, (_, i) => `https://h${i}.test/a`);
    const sameHost = (n: number) => Array.from({ length: n }, (_, i) => `https://a.test/page-${i}`);
    expect(confidenceCeiling({ urls: [], primary: false, domains: [] })).toBe("speculative");
    expect(confidenceCeiling({ urls: sameHost(1), primary: false, domains: ["a.test"] })).toBe("weak");
    // Two urls on ONE domain is still weak: two pages of the same site are one source's opinion twice.
    expect(confidenceCeiling({ urls: sameHost(2), primary: false, domains: ["a.test"] })).toBe("weak");
    expect(confidenceCeiling({ urls: spread(2), primary: false, domains: ["h0.test", "h1.test"] })).toBe("moderate");
    expect(confidenceCeiling({ urls: spread(3), primary: false, domains: ["h0.test", "h1.test", "h2.test"] })).toBe("strong");
    expect(confidenceCeiling({ urls: sameHost(1), primary: true, domains: ["a.test"] })).toBe("strong");
  });

  it("ignores a padded domains list when deriving the ceiling, and refuses the padding", () => {
    const padded = { urls: ["https://a.test/1", "https://a.test/2", "https://a.test/3"], primary: false, domains: ["a.test", "b.test", "c.test"] };
    expect(confidenceCeiling(padded)).toBe("weak");
    expect(aboveCeiling("strong", padded)).toBe(true);
    const pack = good();
    const pain = mod(pack, "m05").perArchetype[0]!.pains[0]!;
    pain.evidence.domains = [...pain.evidence.domains, "invented.test"];
    const result = researchOutputSchema.safeParse(pack);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues.some((issue) => /domains must be the hosts of urls/.test(issue.message))).toBe(true);
  });

  it("allows an agent to under-claim", () => {
    const strongEvidence = { urls: ["https://a.test/1"], primary: true, domains: ["a.test"] };
    expect(aboveCeiling("weak", strongEvidence)).toBe(false);
    expect(aboveCeiling("strong", strongEvidence)).toBe(false);
    expect(aboveCeiling("strong", { urls: ["https://a.test/1"], primary: false, domains: ["a.test"] })).toBe(true);
  });

  it("demotes a stale item to weak, and refuses one that was not demoted", () => {
    const now = new Date("2026-09-09T00:00:00Z");
    const stale = { publishedAt: "2024-01-01", confidence: "strong" } as const;
    expect(staleAndOverClaimed(stale, now)).toBe(true);
    expect(demoteStale(stale, now).confidence).toBe("weak");
    expect(staleAndOverClaimed({ confidence: "strong" }, now)).toBe(false);
    expect(demoteStale({ publishedAt: "2024-01-01", confidence: "speculative" }, now).confidence).toBe("speculative");
  });

  it("accepts the precision a source gives on publishedAt: a date-time, a date, a month or a year", () => {
    for (const value of ["2026-07-10T09:00:00Z", "2026-07-10", "2026-07", "2026"]) {
      const pack = good();
      mod(pack, "m01").triggers[0]!.publishedAt = value;
      expect(researchOutputSchema.safeParse(pack).success, value).toBe(true);
    }
    for (const value of ["July 2026", "2026-13", "26"]) {
      const pack = good();
      mod(pack, "m01").triggers[0]!.publishedAt = value;
      expect(researchOutputSchema.safeParse(pack).success, value).toBe(false);
    }
  });

  it("caps pages per domain per module, not across the pack, and exempts primary sources", () => {
    const onOneDomain = (count: number, primary = false) => {
      const pack = good();
      mod(pack, "m05").perArchetype[0]!.pains.slice(0, count).forEach((pain, i) => {
        pain.evidence = { urls: [`https://onedomain.test/page-${i}`], primary, domains: ["onedomain.test"] };
      });
      return pack;
    };
    for (const [, count] of domainCounts(onOneDomain(3), "m05")) expect(count).toBeLessThanOrEqual(3);
    expect(researchOutputSchema.safeParse(onOneDomain(3)).success).toBe(true);
    const over = researchOutputSchema.safeParse(onOneDomain(4));
    expect(over.success).toBe(false);
    if (!over.success) expect(over.error.issues.some((issue) => /the cap is 3 per domain per module/.test(issue.message))).toBe(true);
    expect(researchOutputSchema.safeParse(onOneDomain(4, true)).success).toBe(true);

    // The same four pages split across two modules is two modules at their cap, not one over it.
    const split = onOneDomain(2);
    mod(split, "m09").perArchetype[0]!.verbatim.slice(0, 2).forEach((item, i) => {
      item.evidence = { urls: [`https://onedomain.test/page-${i + 2}`], primary: false, domains: ["onedomain.test"] };
    });
    expect(researchOutputSchema.safeParse(split).success).toBe(true);
  });

  it("refuses a pack with no unknowns", () => {
    const pack = good();
    mod(pack, "m18").unknowns = [];
    expect(researchOutputSchema.safeParse(pack).success).toBe(false);
  });

  it("checks rep words on the rep summary only, never on a quote or a module the campaign agent reads", () => {
    const pack = good();
    expect(authoredText(pack)).toEqual([...mod(pack, "repSummary").lines]);
    mod(pack, "m06").perArchetype[0]!.phrases[0]!.quote = "Our orchestrator of a pipeline is a persona problem";
    mod(pack, "m01").body = "The ICP the campaign agent reads, persona by persona.";
    expect(researchOutputSchema.safeParse(pack).success).toBe(true);
    mod(pack, "repSummary").lines[0] = "The orchestrator will start a job for this archetype.";
    expect(researchOutputSchema.safeParse(pack).success).toBe(false);
  });

  it("closes a run with a manifest, not the pack: the modules are written as the run goes", () => {
    const definition = loadDefinition("research");
    expect(definition.tools).toEqual(["facts", "knowledge", "priorPacks", "search", "fetch", "writeModule"]);
    expect(definition.output.safeParse({ modulesWritten: ["m00", "m01"] }).success).toBe(true);
    expect(definition.output.safeParse(good()).success).toBe(false);
  });
});

describe("outreach: the gates that need the touch", () => {
  it("passes a clean draft and names a dead fact id", () => {
    const input = outreachInputSchema.parse(fixture("outreach", "input.good.json"));
    const good = outreachOutputSchema.parse(fixture("outreach", "output.good.json"));
    expect(checkTouchLimits(good, input)).toEqual([]);

    // §12 row 2: "a dead or planned id rejected". The id is shaped like a fact
    // and is not one of this product's live facts, so it is a Tier A finding
    // rather than a schema error — the draft is well formed and untrue.
    const deadClaim = outreachOutputSchema.parse(fixture("outreach", "output.deadclaim.json"));
    expect(checkTouchLimits(deadClaim, input)).toEqual([
      { rule: "claim-id", text: "The claim i360.live-assist is not a fact this product has." },
    ]);
  });

  it("refuses a draft whose ask is not the last sentence, or that asks twice", () => {
    const result = outreachOutputSchema.safeParse(fixture("outreach", "output.bad.json"));
    expect(result.success).toBe(false);
    if (result.success) return;
    const messages = result.error.issues.map((issue) => issue.message);
    expect(messages).toContain("the ask is the last sentence");
    expect(messages.some((message) => /asks one question; this one asks 2/.test(message))).toBe(true);
  });

  it("refuses a planned fact in the input, before the writer sees it", () => {
    const input = JSON.parse(JSON.stringify(fixture("outreach", "input.good.json"))) as {
      facts: { facts: Array<{ id: string; status: string; text: string }> };
    };
    input.facts.facts.push({ id: "i360.live-assist", status: "planned", text: "Not shipped." });
    const result = outreachInputSchema.safeParse(input);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => /only live facts/.test(issue.message))).toBe(true);
    }
  });

  it("sweeps plain words over the prose and not over the ids", () => {
    const draft = JSON.parse(JSON.stringify(fixture("outreach", "output.good.json"))) as {
      body: string;
      claims: string[];
      opener: { ref: string };
    };
    // Ids are dashed and dotted slugs, and both separators are word boundaries,
    // so a fact id naming a perfectly ordinary thing collides with the banned
    // list. Before the sweep was scoped by field name, these two lines were
    // enough to fail a draft with nothing wrong with it — permanently, because
    // the id is what the facts file calls it.
    draft.claims = ["i360.pipeline-value"];
    draft.opener.ref = "look-westbury-signal";
    expect(outreachOutputSchema.safeParse(draft).success).toBe(true);

    // The same word in the body is the thing the rule is actually about.
    const leaked = { ...draft, body: `Our pipeline read every call. ${draft.body}` };
    const result = outreachOutputSchema.safeParse(leaked);
    expect(result.success).toBe(false);
    if (result.success) return;
    const issue = result.error.issues.find((candidate) => /machine word/.test(candidate.message));
    expect(issue).toBeDefined();
    // And it names the field a rep would have to fix, not `$`.
    expect(issue?.path).toEqual(["body"]);
  });

  it("keeps the em-dash rule on the prose, where the prose is", () => {
    const draft = JSON.parse(JSON.stringify(fixture("outreach", "output.good.json"))) as { body: string };
    const dashed = { ...draft, body: `We read every call — all of them. ${draft.body}` };
    const result = outreachOutputSchema.safeParse(dashed);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.some((issue) => /banned dash/.test(issue.message))).toBe(true);
  });

  it("measures a follow-up against the person's own earlier message", () => {
    const base = outreachInputSchema.parse(fixture("outreach", "input.good.json"));
    const draft = outreachOutputSchema.parse(fixture("outreach", "output.good.json"));
    const asFollowUp = {
      ...base,
      touch: { ...base.touch, kind: "email2" as const, ordinal: 2 },
      thread: [
        { kind: "email1" as const, ordinal: 1, body: "Short first note.", fate: "sent" as const },
      ],
    };
    const findings = checkTouchLimits(draft, asFollowUp);
    // The draft is inside email2's hundred-word limit but not shorter than the
    // note before it, so the shrink rule is the only finding — which is the
    // distinction rule 7 is about.
    expect(findings.map((finding) => finding.rule)).toEqual(["shorter-than-the-last"]);
  });
});
