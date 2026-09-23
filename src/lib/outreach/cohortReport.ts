import type { EvidenceQuote } from "../../../agents/outreach/input.schema";

import { attributesASource, evidenceUsedIn, sentences, type Finding } from "./gates";
import type { CheckedSequence } from "./messageChecks";

/**
 * The M2 items of the cohort report (M2 brief §6, as fix round 1 finished it): the gate hits, every held
 * touch with its reasons, the humanizer's completion, the phrases repeated across people, and every
 * regulator or publication reference with the approved quote it carries. Pure: the cohort script reads the
 * rows out of the database and this turns them into markdown, so the counting is tested without a model.
 */

export type ReportTouch = { person: string; touch: string; state: string; findings: Finding[] };
export type ReportHumanizer = { person: string; ran: boolean; error?: string; kept: number; returned: number; touches: number };

const TOUCH_NAME: Record<string, string> = {
  email1: "Email 1",
  email2: "Email 2",
  breakup: "Email 3",
  li_connect: "LinkedIn note",
  li_dm: "LinkedIn message",
  li_dm2: "LinkedIn follow-up",
  call: "Call script",
};

const name = (touch: string) => TOUCH_NAME[touch] ?? touch;
const cell = (text: string) => text.replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();

/** Four-word phrases, lower case, with the person's own names taken out so "at Ardent" is not a repeat. */
function grams(text: string, own: readonly string[]): string[] {
  let out = text.toLowerCase().replace(/[’‘]/g, "'");
  for (const value of own) if (value.trim() !== "") out = out.split(value.toLowerCase()).join(" ");
  const list = out.match(/[a-z0-9£%']+/g) ?? [];
  return list.slice(0, Math.max(0, list.length - 3)).map((_, i) => list.slice(i, i + 4).join(" "));
}

/** The four-word phrases used by the most people, at least two, most first. */
export function repeatedPhrases(sequences: readonly CheckedSequence[], top = 10): { phrase: string; people: number; uses: number }[] {
  const people = new Map<string, Set<string>>();
  const uses = new Map<string, number>();
  for (const sequence of sequences) {
    const own = sequence.name.split(/\s+/);
    for (const touch of sequence.touches) {
      for (const gram of grams(`${touch.subject ?? ""}\n${touch.body}`, own)) {
        people.set(gram, (people.get(gram) ?? new Set()).add(sequence.name));
        uses.set(gram, (uses.get(gram) ?? 0) + 1);
      }
    }
  }
  return [...people.entries()]
    .map(([phrase, who]) => ({ phrase, people: who.size, uses: uses.get(phrase) ?? 0 }))
    .filter((row) => row.people >= 2)
    .sort((a, b) => b.people - a.people || b.uses - a.uses || a.phrase.localeCompare(b.phrase))
    .slice(0, top);
}

/** Every sentence that attributes something to a source, with the approved quotes it (or a neighbour) carries. */
export function sourceReferences(sequences: readonly CheckedSequence[], evidence: readonly EvidenceQuote[]): { person: string; touch: string; sentence: string; quotes: string[] }[] {
  const found: { person: string; touch: string; sentence: string; quotes: string[] }[] = [];
  for (const sequence of sequences) {
    for (const touch of sequence.touches) {
      for (const part of [touch.subject ?? "", ...touch.body.split(/\n+/)]) {
        const list = sentences(part);
        list.forEach((sentence, index) => {
          if (!attributesASource(sentence)) return;
          const near = [list[index - 1] ?? "", sentence, list[index + 1] ?? ""].join(" ");
          found.push({ person: sequence.name, touch: touch.kind, sentence, quotes: evidenceUsedIn(near, evidence) });
        });
      }
    }
  }
  return found;
}

export function renderM2Report(input: {
  touches: readonly ReportTouch[];
  humanizer: readonly ReportHumanizer[];
  sequences: readonly CheckedSequence[];
  evidence: readonly EvidenceQuote[];
  timeouts: number;
  modelRuns: number;
}): string {
  const held = input.touches.filter((touch) => touch.state !== "to_review");
  const hits = new Map<string, number>();
  for (const touch of held) for (const rule of new Set(touch.findings.map((finding) => finding.rule))) hits.set(rule, (hits.get(rule) ?? 0) + 1);
  const ran = input.humanizer.filter((person) => person.ran).length;
  const phrases = repeatedPhrases(input.sequences);
  const references = sourceReferences(input.sequences, input.evidence);
  const byId = new Map(input.evidence.map((quote) => [quote.id, quote]));
  return [
    "## M2 report",
    "",
    `Read from the stored drafts: the findings are the ones a rep sees on the card, after the corrective call and the humanizer. **Model runs that ran out of time:** ${input.timeouts} of ${input.modelRuns}.`,
    "",
    "### Gate hits (Tier A, touches held or not written)",
    "",
    "| Rule | Touches |",
    "|---|---|",
    ...([...hits.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([rule, count]) => `| ${rule} | ${count} |`) as string[]),
    ...(hits.size === 0 ? ["| none | 0 |"] : []),
    "",
    `### Held touches, with reasons (${held.length} of ${input.touches.length})`,
    "",
    ...(held.length === 0 ? ["None."] : held.map((touch) => `- **${touch.person}, ${name(touch.touch)}** (${touch.state}): ${touch.findings.map((finding) => `\`${finding.rule}\` ${cell(finding.text)}`).join("; ")}`)),
    "",
    "### Humanizer completion",
    "",
    `The pass ran for **${ran} of ${input.humanizer.length}** people.`,
    "",
    "| Person | Ran | Touches it returned | Humanized version kept | Why not |",
    "|---|---|---|---|---|",
    ...input.humanizer.map((person) => `| ${person.person} | ${person.ran ? "yes" : "**no**"} | ${person.returned} of ${person.touches} | ${person.kept} of ${person.touches} | ${cell(person.error ?? "")} |`),
    "",
    "### The 10 most repeated four-word phrases across people",
    "",
    "| Phrase | People | Uses |",
    "|---|---|---|",
    ...(phrases.length === 0 ? ["| none shared by two people | | |"] : phrases.map((row) => `| ${row.phrase} | ${row.people} | ${row.uses} |`)),
    "",
    `### Every regulator or publication reference (${references.length})`,
    "",
    "| Person | Touch | Sentence | Approved quote carried |",
    "|---|---|---|---|",
    ...(references.length === 0
      ? ["| none | | | |"]
      : references.map((row) => `| ${row.person} | ${name(row.touch)} | ${cell(row.sentence)} | ${row.quotes.length === 0 ? "**none**" : row.quotes.map((id) => `${id} (${cell(byId.get(id)?.sourceName ?? "")})`).join(", ")} |`)),
    "",
  ].join("\n");
}
