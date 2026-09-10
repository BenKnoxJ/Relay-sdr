import { describe, expect, it } from "vitest";

import { MODULE_IDS } from "../../agents/research/output.schema";
import { loadFacts } from "@/lib/facts/load";
import { loadNeverSay, neverSayFileSchema, neverSayIssues } from "@/lib/facts/neverSay";

import { goodPack } from "../agents/researchPack";

/**
 * The never-say list: the facts file's usage notes as a lint over what the
 * research agent authored (audit 2026-09-10, brief E).
 */

const list = loadNeverSay("insights360", 1);
const hits = (text: string): string[] => neverSayIssues([{ where: "t", text }], list);

describe("the never-say list", () => {
  it("parses, every pattern compiles, and every factId is in the signed facts file", () => {
    expect(neverSayFileSchema.safeParse(list).success).toBe(true);
    const ids = new Set(loadFacts("insights360", 1).file.facts.map((fact) => fact.id));
    for (const entry of list.entries) if (entry.factId !== undefined) expect(ids.has(entry.factId), entry.id).toBe(true);
  });

  const seeded: Array<[string, string]> = [
    ["independently-audited", "Insights360's tenant isolation has been independently audited."],
    ["independently-audited", "The platform is pen-tested every year."],
    ["independently-audited", "Insights360 passed a penetration test last spring."],
    ["real-time-results", "Insights360 shows scores in real time on the dashboard."],
    ["real-time-results", "Insights360 gives real-time alerts to supervisors."],
    ["within-minutes", "With Insights360, results are typically within minutes of the call ending."],
    ["uk-data-residency", "With Insights360 your call data never leaves the UK."],
    ["uk-data-residency", "Insights360 data is hosted in the UK."],
    ["uk-data-residency", "The platform offers UK data residency."],
    ["every-call-absolute", "Insights360 scores 100% of calls instead of 2%."],
    ["every-call-absolute", "Insights360 checks every call you make."],
    ["unwired-integrations", "Insights360 integrates with Microsoft Teams."],
    ["unwired-integrations", "The platform plugs straight into Avaya."],
    ["seamless", "Setting up Insights360 is seamless."],
    ["free-or-instant-start", "Start Insights360 with a free trial."],
    ["free-or-instant-start", "With Insights360 you get started in seconds."],
    ["product-iso-certified", "Insights360 is ISO 27001 certified."],
    ["trifle", "Trifle Solutions already uses it."],
    ["call-recording-product", "Insights360 is a call-recording platform for law firms."],
    ["aws-comprehend", "Insights360 takes sentiment from AWS Comprehend."],
    ["per-team-scorecards", "Insights360 runs per-team scorecards for conveyancing and PI."],
    ["vulnerability-module", "Insights360's vulnerability detection module spots at-risk callers."],
    ["full-audit-trail", "Insights360 keeps a full audit trail of every action."],
    ["bulk-export", "The platform offers bulk CSV export for your regulator."],
    ["audio-playback", "In Insights360 you listen to the evidence in the app."],
    ["agent-self-service", "With Insights360, agents can see their own QA scores."],
    ["evidence-packs", "Insights360 produces one-click compliance evidence packs for the SRA."],
    ["sso-redaction-crm", "Insights360 supports SSO and PII redaction."],
    ["retention-period", "The platform retains recordings for 90 days."],
    ["end-to-end", "Insights360 is an end-to-end QA solution."],
  ];
  for (const [id, sentence] of seeded) {
    it(`fires for ${id}: "${sentence}"`, () => {
      const found = hits(sentence);
      expect(found.length, `${sentence} → ${found.join(" | ")}`).toBeGreaterThan(0);
      const entry = list.entries.find((e) => e.id === id)!;
      expect(found.some((issue) => issue.includes(entry.sayInstead))).toBe(true);
    });
  }

  it("does not fire on what the facts file allows", () => {
    for (const sentence of [
      "Conversant is ISO 27001 certified at group level.",
      "Tenant isolation was internally audited.",
      "Results arrive the same day, within a couple of hours.",
      "Every call we ingest is scored against your own rules.",
      "It works with recordings from Microsoft Teams, scoped per customer during onboarding.",
      "Hosted in the EU (Frankfurt).",
      "There is a GBP 1,280 setup fee and a GBP 640 configuration review.",
      "The SRA expects firms to keep records for six years.",
      "EvaluAgent offers SSO and PII redaction on its enterprise tier.",
      // Findings about someone else, not our copy (brief E, 2026-09-10).
      "EvaluAgent offers a free trial and coaching workflows.",
      "Scorebuddy is penetration tested annually.",
      "Firms that want real-time agent assist are out of scope.",
      "The public integrations page claims Insights360 integrates with Microsoft Teams.",
      "The knowledge set's overview says results arrive typically within minutes; the facts file wins.",
    ]) {
      expect(hits(sentence), sentence).toEqual([]);
    }
  });

  it("treats a negated phrase as guidance, except a name that must never appear", () => {
    expect(hits('Say "internally audited", never "pen-tested".')).toEqual([]);
    expect(hits("Insights360 does not run in real time and has no real-time alerts.")).toEqual([]);
    expect(hits("Never write that it integrates with Teams.")).toEqual([]);
    expect(hits("Never name Trifle Solutions.")).toHaveLength(1);
    expect(hits("Trifle Solutions")).toHaveLength(1);
  });

  it("fires without the product named when the field speaks in the product's voice (m09 angles, m15 proof)", () => {
    const sentence = "Tenant scoping was independently audited.";
    expect(neverSayIssues([{ where: "m02.competitors.0.strengths.0", text: sentence }], list)).toEqual([]);
    expect(neverSayIssues([{ where: "m15.proof.1.text", text: sentence, aboutProduct: true }], list)).toHaveLength(1);
    // Guidance is still guidance in the product's voice.
    expect(neverSayIssues([{ where: "m15.proof.1.note", text: 'Say "internally audited", never "independently audited".', aboutProduct: true }], list)).toEqual([]);
  });

  it("stays quiet on the complete pack the runtime tests use", () => {
    const pack = goodPack({ liveFactId: "i360.product.post-call-call-analytics" });
    const texts: Array<{ where: string; text: string }> = [];
    const walk = (value: unknown, where: string): void => {
      if (typeof value === "string") texts.push({ where, text: value });
      else if (Array.isArray(value)) value.forEach((v, i) => walk(v, `${where}.${i}`));
      else if (value !== null && typeof value === "object") {
        for (const [key, v] of Object.entries(value)) if (!["quote", "speaker", "role", "url", "urls", "domains", "source"].includes(key)) walk(v, `${where}.${key}`);
      }
    };
    for (const id of MODULE_IDS) walk((pack.modules as Record<string, unknown>)[id], id);
    expect(neverSayIssues(texts, list)).toEqual([]);
  });

  it("refuses a list whose pattern does not compile", () => {
    expect(neverSayFileSchema.safeParse({ ...list, entries: [{ ...list.entries[0]!, pattern: "(" }] }).success).toBe(false);
  });
});
