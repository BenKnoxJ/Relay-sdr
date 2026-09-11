/**
 * Render a recorded research v3 run as plain markdown for a human review.
 *
 *   npx tsx scripts/research-render.ts fixtures/research/<name>.json [out.md]
 *
 * Reads what `scripts/research-bench.ts` wrote and writes the pack in module
 * order: each module's prose verbatim, then its structured records compactly
 * (kinds of buyer, seed firms, candidates, unknowns, sources), modules stored
 * `insufficient` flagged with their issues, missing modules listed, then the
 * run's numbers and the rubric. No model call; free to run as often as wanted.
 * A fixture recorded under the v2 contract is refused: it has no modules.
 */
import { readFileSync, writeFileSync } from "node:fs";

import { MODULE_IDS, MODULE_TITLES, moduleItems, type ModuleId, type PackShape } from "../agents/research/output.schema";

type Item = { text: string; quote?: string; speaker?: string; role?: string; publishedAt?: string; confidence: string; evidence: { urls: string[] } };
type Loose = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
type Fixture = {
  name?: string;
  contract?: string;
  output?: PackShape | null;
  run?: { modelSteps: number; toolSteps: number; moduleWrites?: number; attempts?: number; cost: string; durationMs: number };
  report?: { insufficientModules?: string[]; reasked?: string[][]; endings?: Array<{ ending: string; message?: string }> } | null;
  rubric?: Array<{ check: number; name: string; verdict: string; detail: string }>;
  error?: string | null;
};

const [, , file, out] = process.argv;
if (file === undefined) throw new Error("usage: research-render <fixture.json> [out.md]");
const fixture = JSON.parse(readFileSync(file, "utf8")) as Fixture;
const pack = fixture.output ?? null;
if (pack === null) throw new Error(`${file} holds no pack (error: ${fixture.error ?? "none"})`);
if ((pack as Loose).modules === undefined) throw new Error(`${file} was recorded under research v2 (no modules); re-record it with the v3 bench before rendering`);

const lines: string[] = [];
const item = (i: Item, label?: string): string => {
  const who = i.speaker === undefined ? "" : ` — ${i.speaker}${i.role === undefined ? "" : `, ${i.role}`}`;
  const when = i.publishedAt === undefined ? "" : ` (${i.publishedAt.slice(0, 10)})`;
  const quote = i.quote === undefined ? "" : `\n  > "${i.quote}"${who}${when}`;
  return `- ${label === undefined ? "" : `**${label}** `}${i.text} _[${i.confidence}]_${quote}\n  ${i.evidence.urls.map((u) => `<${u}>`).join(" · ")}`;
};

/** The structured records a reviewer needs beside the prose, per module. */
function records(id: ModuleId, m: Loose): string[] {
  const outLines: string[] = [];
  switch (id) {
    case "m00":
      outLines.push("**Hard filters**", "```json", JSON.stringify(m.hardFilters, null, 2), "```");
      break;
    case "repSummary":
      outLines.push(...(m.lines as string[]).map((l) => `- ${l}`));
      break;
    case "m01":
      outLines.push("**Sub-segments**", ...(m.subSegments as Loose[]).map((s) => `- ${s.name} — ${s.fit}: ${s.why}`), "**Triggers**", ...(m.triggers as Item[]).map((t) => item(t)));
      break;
    case "m02":
      outLines.push("**Pricing**", "| name | price | minimum | commitment |", "|---|---|---|---|", ...(m.pricingTable as Loose[]).map((r) => `| ${r.name} | ${r.price} | ${r.minimum ?? ""} | ${r.commitment ?? ""} |`));
      break;
    case "m03":
      for (const a of m.archetypes as Loose[]) {
        outLines.push(`**${a.name}** (\`${a.id}\`, ${a.sizeRange}): ${a.situation}`, item(a.dominantPain as Item, "Dominant pain:"), ...(a.roles as Loose[]).map((r) => `- ${r.title} (${r.seniority}) ${r.part}: ${r.needs}`), `- opening angle: ${a.openingAngle}`, `- deal economics: ${[a.dealEconomics.seatRange, a.dealEconomics.plan, a.dealEconomics.yearOneValue].filter(Boolean).join(", ") || "—"} _[${a.dealEconomics.confidence}]_`);
      }
      break;
    case "m04":
      for (const t of m.perArchetype as Loose[]) {
        outLines.push(`**${t.archetypeId}**`, "```json", JSON.stringify(t.recipe), "```", ...(t.triggerTaxonomy as Loose[]).map((r) => `- ${r.strength} ${r.signal} — ${r.whereToFind}`));
        for (const f of t.seedFirms as Loose[]) outLines.push(`- firm **${f.name}**${f.domain === undefined ? "" : ` (${f.domain})`}, ${f.region}, size ${f.size.status}${f.size.value === undefined ? "" : ` ${f.size.value}`}`, `  ${item(f.signal as Item).replace(/^- /, "")}`);
      }
      break;
    case "m05":
      for (const p of m.perArchetype as Loose[]) outLines.push(`**${p.archetypeId}**`, ...(p.pains as Item[]).map((i) => item(i)));
      break;
    case "m06":
      for (const p of m.perArchetype as Loose[]) {
        outLines.push(`**${p.archetypeId}**`);
        for (const ph of p.phrases as Loose[]) outLines.push(item(ph as Item), `  say: "${ph.say}"${ph.notThis === undefined ? "" : ` · not: "${ph.notThis}"`}${ph.notBuyer ? " · _vendor voice_" : ""}`);
      }
      break;
    case "m07":
      outLines.push(...(m.mappings as Loose[]).map((x) => `- ${x.painId} → ${x.capability}${x.mustNotImply === undefined ? "" : ` (not: ${x.mustNotImply})`}`), ...(m.unmatched as Loose[]).map((x) => `- ${x.painId} → unmatched (${x.roadmapStatus})`));
      break;
    case "m09":
      for (const p of m.perArchetype as Loose[]) outLines.push(`**${p.archetypeId}**`, ...(p.angles as Loose[]).map((a) => `${a.rank}. ${a.text} _[${a.confidence}; ${a.channelFit.join(", ")}]_`));
      break;
    case "m13":
      outLines.push(...(m.entries as Loose[]).map((e) => `- ${e.date}: ${e.what} <${e.source}>`));
      break;
    case "m16":
      outLines.push(...(m.candidates as Loose[]).slice().sort((a, b) => a.rank - b.rank).map((c) => `${c.rank}. ${c.archetypeId}: ${c.leadAngle} (${c.channelFit.join(", ")}). Why now: ${c.whyNow}. Wrong if: ${c.wrongIf}`));
      break;
    case "m17":
      outLines.push(...(m.entries as Loose[]).map((c) => `- (${c.kind}) ${c.text} — ${c.meaning}`));
      break;
    case "m18":
      outLines.push(...(m.unknowns as Loose[]).map((u) => `- (${u.kind}) ${u.text} — ${u.whyItMatters}`));
      break;
    case "m19":
      outLines.push(...(m.sources as Loose[]).map((s) => `- ${s.title} <${s.url}> (${s.accessedAt})`), `- facts v${m.factsVersion}; knowledge: ${(m.knowledgeArticles as string[]).join(", ")}`);
      break;
    default:
      break;
  }
  return outLines;
}

if (pack.insufficient !== undefined) {
  // v3.2 (§10 note 28): a stopped pack leads with the stop. What follows it is evidence, not a campaign.
  const stop = pack.insufficient;
  const byId = new Map([...moduleItems(pack, "m00"), ...moduleItems(pack, "m01")].map((i) => [i.id, i]));
  lines.push(
    "# Research stopped: evidence insufficient",
    "",
    `_${fixture.name ?? file}_${pack.scope === undefined ? "" : ` · scope: ${JSON.stringify(Object.fromEntries(Object.entries(pack.scope).filter(([k]) => k !== "supplied")))}`}`,
    "",
    "## What was found in scope",
    ...(stop.evidenceIds.length === 0 ? ["- nothing inside the brief"] : stop.evidenceIds.map((id) => (byId.has(id) ? item(byId.get(id)! as Item) : `- ${id} (not in m00 or m01)`))),
    "",
    "## Why Relay stopped",
    stop.reason,
    "",
    "## Ways to widen — each needs a new brief the rep approves",
    ...stop.widenings.map((w, i) => `${i + 1}. **${w.dimension}**: ${w.text}\n   scope change: \`${JSON.stringify(w.scopePatch)}\``),
    "",
    "## Gathered evidence — not campaign-ready",
    "",
    "> Written before the stop. It is what research found, not a pack a campaign can run on.",
    "",
  );
} else {
  lines.push(`# Research pack — ${fixture.name ?? file}`, "");
}
if (pack.partial && pack.insufficient === undefined) lines.push(`> **Partial:** missing ${pack.missingModules.join(", ")}`, "");
for (const id of MODULE_IDS) {
  const m = (pack.modules as Record<string, Loose | undefined>)[id];
  if (m === undefined) {
    lines.push(`## ${id} ${MODULE_TITLES[id]} — not written`, "");
    continue;
  }
  lines.push(`## ${id} ${MODULE_TITLES[id]}${m.status === "insufficient" ? " — INSUFFICIENT" : ""}`, "");
  if (m.status === "insufficient") lines.push(`> Issues: ${(m.issues as string[]).join("; ")}`, "");
  lines.push(m.body as string, "");
  if (m.status === "complete") {
    const extra = records(id, m);
    if (extra.length > 0) lines.push(...extra, "");
  }
  const claims = (m.claims as Item[]) ?? [];
  if (claims.length > 0) lines.push("**Claims**", ...claims.map((c) => item(c)), "");
}
if (fixture.run !== undefined) {
  lines.push("## The run", `- ${fixture.run.attempts ?? 1} attempt(s), ${fixture.run.modelSteps} model turns, ${fixture.run.toolSteps} tool calls (${fixture.run.moduleWrites ?? "?"} module writes), ${Math.round(fixture.run.durationMs / 1000)}s, $${Number(fixture.run.cost).toFixed(2)}`);
  if (fixture.report?.reasked !== undefined && fixture.report.reasked.length > 0) lines.push(`- re-asked: ${fixture.report.reasked.map((r) => r.join(", ")).join(" | ")}`);
  if (fixture.report?.insufficientModules !== undefined && fixture.report.insufficientModules.length > 0) lines.push(`- stored insufficient at ingest: ${fixture.report.insufficientModules.join(", ")}`);
  lines.push("");
}
if (fixture.rubric !== undefined && fixture.rubric.length > 0) lines.push("## Rubric", "| # | check | verdict | detail |", "|---|---|---|---|", ...fixture.rubric.map((r) => `| ${r.check} | ${r.name} | ${r.verdict} | ${r.detail} |`), "");

const md = lines.join("\n");
if (out === undefined) process.stdout.write(md);
else {
  writeFileSync(out, md);
  console.log(`wrote ${out} (${md.length} chars)`);
}
