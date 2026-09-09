/**
 * Render a recorded research run as plain markdown for a human review.
 *
 *   npx tsx scripts/research-render.ts fixtures/agents/research/<name>.json [out.md]
 *
 * Reads what `scripts/research-bench.ts` wrote (or a rejected-answer file
 * from ~/.relay/agents/research/runs) and writes the pack the way a rep would
 * read it: summary, kinds of buyer with their pains and their words, the hook,
 * seed firms, the search recipe, unknowns, contradictions, then the run's
 * numbers and the rubric. No model call; free to run as often as wanted.
 */
import { readFileSync, writeFileSync } from "node:fs";

import type { ResearchPack } from "../agents/research/output.schema";

type Item = { text: string; quote?: string; speaker?: string; role?: string; publishedAt?: string; confidence: string; evidence: { urls: string[] } };
type Fixture = {
  name?: string;
  breadth?: string;
  output?: ResearchPack | null;
  text?: string;
  issues?: string[];
  run?: { modelSteps: number; toolSteps: number; cost: string; durationMs: number };
  rubric?: Array<{ check: number; name: string; verdict: string; detail: string }>;
  error?: string | null;
};

const [, , file, out] = process.argv;
if (file === undefined) throw new Error("usage: research-render <fixture.json> [out.md]");
const fixture = JSON.parse(readFileSync(file, "utf8")) as Fixture;
const pack = (fixture.output ?? (fixture.text === undefined ? null : (JSON.parse(fixture.text) as ResearchPack))) as ResearchPack | null;
if (pack === null) throw new Error(`${file} holds no pack (error: ${fixture.error ?? "none"})`);

const lines: string[] = [];
const item = (i: Item, label?: string): string => {
  const who = i.speaker === undefined ? "" : ` — ${i.speaker}${i.role === undefined ? "" : `, ${i.role}`}`;
  const when = i.publishedAt === undefined ? "" : ` (${i.publishedAt.slice(0, 10)})`;
  const quote = i.quote === undefined ? "" : `\n  > "${i.quote}"${who}${when}`;
  return `- ${label === undefined ? "" : `**${label}** `}${i.text} _[${i.confidence}]_${quote}\n  ${i.evidence.urls.map((u) => `<${u}>`).join(" · ")}`;
};

lines.push(`# Research pack — ${fixture.name ?? file}${fixture.breadth === undefined ? "" : ` (${fixture.breadth})`}`, "");
if (fixture.issues !== undefined && fixture.issues.length > 0) lines.push("> **Refused by the schema:** " + fixture.issues.join("; "), "");
lines.push("## Summary", ...pack.summary.map((s) => `- ${s}`), "");
for (const a of pack.archetypes) {
  lines.push(`## Kind of buyer: ${a.name}`, "", a.situation, "", "**What hurts**", ...a.pains.map((p) => item(p as Item)), "", "**Their words**");
  for (const ph of a.language) {
    lines.push(item(ph as Item), `  say: "${ph.say}"${ph.notThis === undefined ? "" : ` · not: "${ph.notThis}"`}${ph.notBuyer ? " · _vendor voice_" : ""}`);
  }
  lines.push("");
}
lines.push("## The hook", "", pack.hook.text, "", item(pack.hook.whyNow as Item, "Why now:"), `- answered by facts: ${pack.hook.answeredBy.join(", ")}`, "");
lines.push("## Seed firms");
for (const f of pack.seedFirms) lines.push(`- **${f.name}**${f.domain === undefined ? "" : ` (${f.domain})`}, ${f.region}`, `  ${item(f.signal as Item).replace(/^- /, "")}`);
lines.push("", "## Search recipe", "```json", JSON.stringify(pack.recipe, null, 2), "```", "");
lines.push("## What could not be found", ...pack.unknowns.map((u) => `- (${u.kind}) ${u.text}`), "");
if (pack.contradictions.length > 0) lines.push("## Contradictions", ...pack.contradictions.map((c) => `- ${c.text}`), "");
if (pack.insufficient !== undefined) lines.push("## Stopped as insufficient", ...pack.insufficient.widenings.map((w) => `- widen by ${w.kind}: ${w.text}`), "");
if (fixture.run !== undefined) lines.push("## The run", `- ${fixture.run.modelSteps} model turns, ${fixture.run.toolSteps} tool calls, ${Math.round(fixture.run.durationMs / 1000)}s, $${Number(fixture.run.cost).toFixed(2)}`, "");
if (fixture.rubric !== undefined && fixture.rubric.length > 0) lines.push("## Rubric", "| # | check | verdict | detail |", "|---|---|---|---|", ...fixture.rubric.map((r) => `| ${r.check} | ${r.name} | ${r.verdict} | ${r.detail} |`), "");

const md = lines.join("\n");
if (out === undefined) process.stdout.write(md);
else {
  writeFileSync(out, md);
  console.log(`wrote ${out} (${md.length} chars)`);
}
