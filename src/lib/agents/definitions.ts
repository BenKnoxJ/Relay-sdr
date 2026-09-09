import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { z } from "zod";

import type { PricedModel } from "@/lib/agents/pricing";

import { echoInputSchema } from "../../../agents/echo/input.schema";
import { echoOutputSchema } from "../../../agents/echo/output.schema";
import { leadgenInputSchema } from "../../../agents/leadgen/input.schema";
import { leadgenOutputSchema } from "../../../agents/leadgen/output.schema";
import { orchestratorInputSchema } from "../../../agents/orchestrator/input.schema";
import { orchestratorOutputSchema } from "../../../agents/orchestrator/output.schema";
import { outreachInputSchema } from "../../../agents/outreach/input.schema";
import { outreachOutputSchema } from "../../../agents/outreach/output.schema";
import { researchInputSchema } from "../../../agents/research/input.schema";
import { researchRawSchema } from "../../../agents/research/output.schema";

/**
 * The signed agent definitions, as the code's input.
 *
 * Each agent is a directory under `agents/`: the signed definition verbatim
 * (`definition.md`), the system prompt distilled from its method section
 * (`prompt.md`), its input and output schemas as zod (`input.schema.ts`,
 * `output.schema.ts`), and its sign-off rubric (`rubric.md`). Nothing in this
 * module derives a schema or a budget from a reading of the product docs — the
 * numbers are copied out of the definition with the row they came from named in
 * a comment, and `tests/agents/definitions.test.ts` parses the good and bad
 * fixtures beside them.
 *
 * **Only `echo` is runnable in this task.** The other four are loaded, their
 * schemas compiled and their fixtures checked, and nothing more: `research` is
 * Task 12, `orchestrator` is Task 7, and `leadgen` makes no model calls at all.
 *
 * The markdown is read from disk rather than inlined, so `definition.md` can be
 * a byte-for-byte copy of the signed file and a diff against
 * `~/vault/products/relay/agents/*.v2.signed.md` is meaningful. The consequence
 * is a deployment one: the bundled worker (`dist/worker/main.js`) resolves
 * `agents/` relative to the nearest `package.json` above it, so a deploy that
 * ships `dist/` must ship `agents/` beside the manifest. Task 13 owns that.
 */

export const AGENT_KINDS = ["echo", "research", "orchestrator", "leadgen", "outreach"] as const;
export type AgentKind = (typeof AGENT_KINDS)[number];

/** What a run is allowed to spend. Every number is quoted from the definition. */
export type AgentBudget = {
  /** Hard cap on model calls. The loop stops here, and a run that stops here fails. */
  maxModelSteps: number;
  /** Search tool calls, where the definition sets one. */
  maxSearches?: number;
  /** Fetch tool calls, where the definition sets one. */
  maxFetches?: number;
  /** Wall-clock budget, in seconds, where the definition sets one. */
  maxSeconds?: number;
};

/** The effort levels the model transport accepts (`ClaudeCodeSettings.effort`). */
export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORTS)[number];

export type AgentDefinition<IN = unknown, OUT = unknown> = {
  kind: AgentKind;
  /**
   * Which pinned model the agent runs on, and at what effort, or `null` for an
   * agent that makes no model calls. Decided per agent by the product owner on
   * 2026-09-09 (research Opus 5 at high — the pack is what every draft opens on;
   * orchestrator and outreach Sonnet 5; echo Opus 5, the spike's model) and
   * recorded here rather than in a handler constant, so the choice is in the
   * record a run is checked against. The id must be in the price table.
   */
  model: PricedModel | null;
  effort: Effort | null;
  /**
   * The system prompt, or `null` for an agent that makes no model calls.
   *
   * `null` is lead gen, and it is a first-class case rather than a gap: "Zero
   * model calls. Deterministic code over a Lusha adapter and Zoho reads"
   * (`leadgen.v2.signed.md` §0). `runAgent` refuses a null prompt, so the
   * runtime cannot be pointed at it by mistake.
   */
  prompt: string | null;
  input: z.ZodType<IN>;
  output: z.ZodType<OUT>;
  /** The tool names the definition grants. `runAgent` asserts the supplied set matches. */
  tools: readonly string[];
  budget: AgentBudget;
  /** The signed definition, verbatim. */
  definition: string;
  /** The sign-off rubric. */
  rubric: string;
};

type Spec = {
  input: z.ZodTypeAny;
  output: z.ZodTypeAny;
  model: PricedModel | null;
  effort: Effort | null;
  tools: readonly string[];
  budget: AgentBudget;
  /** False for an agent with no model calls: no `prompt.md` is read. */
  hasPrompt: boolean;
};

const SPECS = {
  echo: {
    input: echoInputSchema,
    output: echoOutputSchema,
    // `agents/echo/definition.md` §4.
    tools: ["shout"],
    // §6: four model steps, two of them headroom.
    budget: { maxModelSteps: 4, maxSearches: 0, maxFetches: 0, maxSeconds: 120 },
    hasPrompt: true,
    model: "claude-opus-5",
    effort: "high",
  },
  research: {
    input: researchInputSchema,
    // The raw rules: the runtime demotes stale items before the strict parse
    // (`src/lib/research/validate.ts`). See the note above `refinePack`.
    output: researchRawSchema,
    // §4, the read-only four. `priorKnowledge` is advisory, `facts` is local.
    tools: ["facts", "priorKnowledge", "search", "fetch"],
    // §6, the `standard` row — one sector national, or a channel motion. The
    // narrow and wide rows are `RESEARCH_BREADTH_BUDGETS` below; the runtime
    // picks by breadth, and `standard` is what a definition loaded without one
    // gets.
    budget: { maxModelSteps: 30, maxSearches: 40, maxFetches: 25, maxSeconds: 15 * 60 },
    hasPrompt: true,
    model: "claude-opus-5",
    effort: "high",
  },
  orchestrator: {
    input: orchestratorInputSchema,
    output: orchestratorOutputSchema,
    // §2: "No fourth call." Code, not tools — the state machine is §5 and is
    // not a tool the model may reach for.
    tools: [],
    // §2: exactly three model steps, and they are three separate calls rather
    // than one loop. The cap is per call; three is the whole agent's ration.
    budget: { maxModelSteps: 3 },
    hasPrompt: true,
    model: "claude-sonnet-5",
    effort: "medium",
  },
  leadgen: {
    input: leadgenInputSchema,
    output: leadgenOutputSchema,
    // §0: no model, so no model-facing tools. The Lusha and Zoho adapters are
    // called by code, which is not the same thing as a tool a model may call.
    tools: [],
    // §0: "Zero model calls."
    budget: { maxModelSteps: 0 },
    hasPrompt: false,
    model: null,
    effort: null,
  },
  outreach: {
    input: outreachInputSchema,
    output: outreachOutputSchema,
    // §4, the lookup: two searches, two fetches, replay keys on both.
    tools: ["search", "fetch"],
    // §0 is one model call per draft; §7 allows at most two Tier A redrafts
    // before the draft parks as `needs_you`, so three calls is the ceiling a
    // single draft job can reach. §4's ninety seconds is the lookup's budget.
    budget: { maxModelSteps: 3, maxSearches: 2, maxFetches: 2, maxSeconds: 90 },
    hasPrompt: true,
    model: "claude-sonnet-5",
    effort: "high",
  },
} as const satisfies Record<AgentKind, Spec>;

/**
 * Research's budget by breadth (§6), runtime-set and never model-chosen.
 *
 * Exported rather than folded into one budget because the definition makes the
 * scaling the point: the brief's shape decides the ration, and Task 12 picks the
 * row. `standard` is the row in `SPECS.research.budget`.
 */
export const RESEARCH_BREADTH_BUDGETS = {
  narrow: { maxModelSteps: 20, maxSearches: 20, maxFetches: 12, maxSeconds: 8 * 60 },
  standard: { maxModelSteps: 30, maxSearches: 40, maxFetches: 25, maxSeconds: 15 * 60 },
  wide: { maxModelSteps: 40, maxSearches: 60, maxFetches: 35, maxSeconds: 20 * 60 },
} as const satisfies Record<string, AgentBudget>;

export type InputOf<K extends AgentKind> = z.infer<(typeof SPECS)[K]["input"]>;
export type OutputOf<K extends AgentKind> = z.infer<(typeof SPECS)[K]["output"]>;

const cache = new Map<AgentKind, AgentDefinition>();

/**
 * The definition for a kind, markdown and all.
 *
 * Memoised: the markdown does not change inside a process, and a worker that
 * drafted four hundred touches should not have read the same prompt four hundred
 * times.
 */
export function loadDefinition<K extends AgentKind>(
  kind: K,
  baseDir: string = agentsDir(),
): AgentDefinition<InputOf<K>, OutputOf<K>> {
  const memo = cache.get(kind);
  if (memo !== undefined && baseDir === agentsDir()) {
    return memo as AgentDefinition<InputOf<K>, OutputOf<K>>;
  }
  const spec: Spec = SPECS[kind];
  const read = (file: string): string => {
    const full = path.join(baseDir, kind, file);
    try {
      return readFileSync(full, "utf8");
    } catch (error) {
      // Named, with the path, because the failure a deploy actually hits is
      // "the `agents/` directory was not shipped" and the fix is that sentence.
      throw new Error(
        `loadDefinition(${kind}): cannot read ${file} at ${full} — is the agents/ directory deployed alongside the worker?`,
        { cause: error },
      );
    }
  };
  const loaded: AgentDefinition = {
    kind,
    prompt: spec.hasPrompt ? read("prompt.md").trim() : null,
    input: spec.input,
    output: spec.output,
    tools: spec.tools,
    budget: spec.budget,
    model: spec.model,
    effort: spec.effort,
    definition: read("definition.md"),
    rubric: read("rubric.md"),
  };
  if (baseDir === agentsDir()) cache.set(kind, loaded);
  return loaded as AgentDefinition<InputOf<K>, OutputOf<K>>;
}

/** Test-only: drop the memo so a later call re-reads the markdown. */
export function resetDefinitions(): void {
  cache.clear();
}

let resolvedAgentsDir: string | undefined;

/**
 * Where `agents/` is.
 *
 * Found by walking up from this module to the nearest directory holding a
 * `package.json`, which is the repository root from `src/lib/agents` and from
 * `dist/worker` alike. An explicit `baseDir` argument overrides it, which is how
 * a test points at a fixture tree.
 */
export function agentsDir(): string {
  if (resolvedAgentsDir !== undefined) return resolvedAgentsDir;
  let directory = path.dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (existsSync(path.join(directory, "package.json"))) {
      resolvedAgentsDir = path.join(directory, "agents");
      return resolvedAgentsDir;
    }
    const parent = path.dirname(directory);
    if (parent === directory) {
      throw new Error("agentsDir: no package.json above src/lib/agents — cannot locate the agents/ directory");
    }
    directory = parent;
  }
}
