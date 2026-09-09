import { loadDefinition, type AgentKind } from "@/lib/agents/definitions";
import type { BenchFixture } from "@/lib/bench/fixture";
import { benchCopy } from "@/lib/copy/bench";

/**
 * The sign-off rubric, as rows the bench can draw checkboxes beside.
 *
 * Every `agents/<kind>/rubric.md` is a three-column markdown table — number,
 * check, what counts as a pass — and it is the signed definition's own words.
 * The bench does not restate them, paraphrase them or keep a second copy: it
 * parses the file. A rubric that changes changes the checklist, which is the
 * only way the checklist can be trusted to be the rubric.
 *
 * Nothing here decides whether a row passed. Most of these rows are a person
 * looking at a screen, and a bench that ticked them itself would be marking its
 * own homework. The two the machine really does know — the output validates,
 * and the run recorded steps and a cost — are computed in
 * `automaticChecks()` and shown apart from the rubric, so the boundary between
 * "checked" and "you looked at it" is on the screen.
 */

export type RubricRow = {
  /** The row's own number, as the rubric writes it. */
  n: string;
  check: string;
  pass: string;
};

/** A markdown table row split on unescaped pipes, trimmed. */
function cells(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

/** True for the `|---|---|---|` separator under a table's header. */
function isSeparator(line: string): boolean {
  return cells(line).every((cell) => /^:?-{3,}:?$/.test(cell));
}

/**
 * The rows of the first three-column table in a rubric.
 *
 * The first table and not every table: a rubric may grow a second one (a cost
 * table, a fixture list), and silently concatenating them would put rows on the
 * checklist that are not checks.
 */
export function parseRubric(markdown: string): RubricRow[] {
  const lines = markdown.split("\n");
  const rows: RubricRow[] = [];
  let inTable = false;
  for (const [index, line] of lines.entries()) {
    if (!line.trim().startsWith("|")) {
      // A blank line or prose ends the table. Once rows have been collected,
      // that is the end of the first table and the end of the parse.
      if (rows.length > 0) break;
      inTable = false;
      continue;
    }
    if (isSeparator(line)) {
      inTable = true;
      continue;
    }
    if (!inTable) {
      // The header row, recognised by the separator on the line below it.
      const next = lines[index + 1];
      if (next === undefined || !next.trim().startsWith("|") || !isSeparator(next)) continue;
      continue;
    }
    const parts = cells(line);
    const [n, check, pass] = parts;
    if (parts.length < 3 || n === undefined || check === undefined || pass === undefined) continue;
    if (n === "" || check === "") continue;
    rows.push({ n, check, pass });
  }
  return rows;
}

/** The rubric for a kind, read off disk through the definition loader. */
export function rubricFor(kind: AgentKind): RubricRow[] {
  return parseRubric(loadDefinition(kind).rubric);
}

/** A check the bench itself can settle, and did. */
export type AutomaticCheck = {
  id: string;
  label: string;
  passed: boolean;
  /** What was actually observed, in one line. */
  detail: string;
};

/**
 * The two things the bench really knows about a fixture.
 *
 * Here rather than in the page so it can be tested without rendering one, and
 * beside `parseRubric` because the pair of them is the whole checklist: what
 * was settled, and what is left for a person.
 */
export function automaticChecks(fixture: BenchFixture): AutomaticCheck[] {
  const checks: AutomaticCheck[] = [
    {
      id: "schema",
      label: fixture.validation.ok ? benchCopy.schemaOk : benchCopy.schemaBad,
      passed: fixture.validation.ok,
      detail: fixture.validation.ok ? "" : fixture.validation.errors.join("; "),
    },
  ];
  if (fixture.source === "sample") return checks;

  const run = fixture.run;
  // Steps, not cost. A run can legitimately record steps and cost nothing — a
  // cached-only call, or a price the table rounds to zero at six decimal
  // places — and labelling that "nothing ran" beside a line reading "3 steps"
  // is the bench contradicting itself. What it cost is on the line either way.
  const ran = run !== null && run.steps > 0;
  checks.push({
    id: "ran",
    label: ran ? benchCopy.ranOk : benchCopy.ranBad,
    passed: ran,
    detail:
      run === null ? benchCopy.notRun : `${run.steps} ${benchCopy.steps} · $${run.cost} · ${run.durationMs}ms`,
  });
  return checks;
}
