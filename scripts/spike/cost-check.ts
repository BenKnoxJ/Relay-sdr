/**
 * Spike proof 1, live: the row equals the wire.
 *
 * One `echo` run against the real Messages API, then a table comparing every
 * recorded step to the provider's own usage and every recorded cost to the pinned
 * price table. Exits non-zero on any mismatch, so it is a gate and not a report.
 *
 * It answered decision **D2** on 2026-09-09: the Messages API refuses the
 * subscription token (`reviews/2026-09-09-spike-runtime-live-D2.md`), and
 * Benny-san's decision was to keep the subscription and change the transport.
 * With a token set the run now goes over the Claude Agent SDK (Task 6c), and the
 * table gains a second check: every model's recorded cost against the SDK's own
 * `modelUsage[model].costUSD`, which is computed independently, at list price,
 * by the subprocess. With an API key set it goes over the Messages API as before.
 *
 * ## Running it
 *
 *   export CLAUDE_CODE_OAUTH_TOKEN="$(claude setup-token)"   # or ANTHROPIC_API_KEY
 *   export DATABASE_URL=postgresql://relay:relay@127.0.0.1:5435/relay_spike
 *   export DIRECT_URL="$DATABASE_URL"
 *   npx tsx scripts/spike/cost-check.ts
 *
 * With neither credential set it prints what is missing and exits 0 — skipped, not
 * failed, so a CI run without a credential is not a red build. With both set it
 * uses the token and never sends the key (Sales360 PR #2's one-credential rule).
 *
 * The write-up goes to stdout. Filing it at
 * `~/vault/products/relay/reviews/2026-09-XX-spike-runtime.md` is the
 * dispatcher's step: this script has no business writing outside the repository.
 */

import { randomUUID } from "node:crypto";

import { echoTools } from "../../agents/echo/tools";
import { loadDefinition } from "@/lib/agents/definitions";
import { cost, PRICE_TABLE_SHA256 } from "@/lib/agents/pricing";
import { credentialKind, makeModel, transportFor } from "@/lib/agents/provider";
import { runAgent } from "@/lib/agents/run";
import { prisma } from "@/lib/db";
import { env } from "@/lib/env";
import { enqueue } from "@/lib/jobs/queue";
import { mutate } from "@/lib/repo/mutate";

const MODEL = "claude-opus-5" as const;
/** The rubric's tolerance: tokens exact, cost within a hundredth of a cent. */
const COST_TOLERANCE = 0.0001;

async function main(): Promise<number> {
  const configured = env();
  const credential = credentialKind(configured);
  if (credential === "none") {
    console.log(
      [
        "SKIPPED — no model credential.",
        "",
        "Set CLAUDE_CODE_OAUTH_TOKEN (the subscription token from `claude setup-token`,",
        "which is the billing path decided on 2026-09-08) or, failing that,",
        "ANTHROPIC_API_KEY. Proof 1's offline half is green either way:",
        "`npm run proofs`.",
      ].join("\n"),
    );
    return 0;
  }

  const orgId = `org_spike_${randomUUID().slice(0, 8)}`;
  await mutate(prisma, {
    orgId,
    actor: { kind: "system" },
    kind: "org.created",
    apply: (tx) => tx.org.create({ data: { id: orgId, name: orgId } }),
  });
  const { job } = await enqueue(prisma, {
    orgId,
    kind: "echo",
    idempotencyKey: `spike-${randomUUID()}`,
    input: { text: "the quick brown fox" },
  });

  const definition = loadDefinition("echo");
  const started = Date.now();
  const result = await runAgent({
    definition,
    input: { text: "the quick brown fox" },
    ctx: {
      db: prisma,
      orgId,
      jobId: job.id,
      model: makeModel(MODEL, configured),
      modelId: MODEL,
      tools: (recorder) => echoTools(recorder),
    },
  });

  const rows: string[] = [];
  let mismatches = 0;

  for (const step of result.steps) {
    if (step.kind !== "model") {
      rows.push(`| ${step.index} | tool: ${step.name} | — | — | — | — | — | — | ok |`);
      continue;
    }
    const meta = step.providerMeta as
      | { usage?: Record<string, number>; rawUsage?: RawUsage | null; source?: string }
      | null;
    const usage = meta?.usage;
    if (usage === undefined) {
      rows.push(`| ${step.index} | model | — | — | — | — | — | — | **no usage recorded** |`);
      mismatches += 1;
      continue;
    }

    const tokenProblems: string[] = [];

    // The row against **the wire**, in Anthropic's own field names, and not
    // against the normalised `usage` beside it — that was derived by the same
    // statement that wrote the columns, so comparing the two is a tautology that
    // can never fail and would report PASS for any bug in the mapping. This is
    // the comparison proof 1 is actually asking for.
    const raw = meta?.rawUsage;
    if (raw === undefined || raw === null) {
      if (meta?.source === undefined) {
        tokenProblems.push("no raw provider usage stored; nothing to compare the row against");
      }
      // A reconciliation row has no wire block of its own: it is the difference
      // between the SDK's per-model total and the turns recorded, and the
      // table below is where it is checked.
    } else {
      const wire = fromWire(raw);
      if (step.tokensIn !== wire.tokensIn) tokenProblems.push(`tokensIn ${step.tokensIn} vs wire ${wire.tokensIn}`);
      if (step.tokensOut !== wire.tokensOut) tokenProblems.push(`tokensOut ${step.tokensOut} vs wire ${wire.tokensOut}`);
      if (step.tokensCached !== wire.tokensCacheRead) {
        tokenProblems.push(`tokensCached ${step.tokensCached} vs wire ${wire.tokensCacheRead}`);
      }
      if (step.tokensReasoning !== wire.tokensReasoning) {
        tokenProblems.push(`tokensReasoning ${step.tokensReasoning} vs wire ${wire.tokensReasoning}`);
      }
      // And the SDK's own reading of the same response, so a disagreement between
      // the provider's JSON and `@ai-sdk/anthropic`'s conversion of it shows up
      // here rather than silently in every cost figure.
      if (usage.tokensInUncached !== wire.tokensInUncached) {
        tokenProblems.push(`noCache ${usage.tokensInUncached} vs wire ${wire.tokensInUncached}`);
      }
      if (usage.tokensCacheWrite !== wire.tokensCacheWrite) {
        tokenProblems.push(`cacheWrite ${usage.tokensCacheWrite} vs wire ${wire.tokensCacheWrite}`);
      }
      if (usage.tokensCacheWrite1h !== wire.tokensCacheWrite1h) {
        tokenProblems.push(`cacheWrite1h ${usage.tokensCacheWrite1h} vs wire ${wire.tokensCacheWrite1h}`);
      }
    }

    const expected = cost(
      {
        tokensIn: usage.tokensIn ?? 0,
        tokensInUncached: usage.tokensInUncached ?? 0,
        tokensCacheRead: usage.tokensCacheRead ?? 0,
        tokensCacheWrite: usage.tokensCacheWrite ?? 0,
        tokensCacheWrite1h: usage.tokensCacheWrite1h ?? 0,
        tokensOut: usage.tokensOut ?? 0,
      },
      // The step's own model: on the Agent SDK a run also records the
      // subprocess's Haiku call under its own id.
      step.name,
    );
    const delta = Math.abs(Number(step.cost.toString()) - Number(expected));
    if (delta > COST_TOLERANCE) tokenProblems.push(`cost ${step.cost.toString()} vs ${expected}`);
    if ((step.providerMeta as { providerMetadata?: unknown } | null)?.providerMetadata === undefined) {
      tokenProblems.push("providerMetadata missing");
    }

    if (tokenProblems.length > 0) mismatches += 1;
    rows.push(
      `| ${step.index} | model: ${step.name}${meta?.source === undefined ? "" : " (reconciliation)"} | ${step.tokensIn} | ${step.tokensOut} | ${step.tokensCached} | ${step.tokensReasoning} | ${step.cost.toString()} | ${expected} | ${tokenProblems.length === 0 ? "ok" : `**${tokenProblems.join("; ")}**`} |`,
    );
  }

  // The run total against the steps, in integer micro-dollars so the comparison
  // is not itself a rounding question.
  const summedMicro = result.steps.reduce(
    (total, step) => total + BigInt(step.cost.mul(1_000_000).toFixed(0)),
    0n,
  );
  const runMicro = BigInt(result.run.costTotal.mul(1_000_000).toFixed(0));
  if (summedMicro !== runMicro) mismatches += 1;

  // The second check, on the Agent SDK only: the SDK's own cost per model,
  // computed by the subprocess at list price, against what this ledger recorded
  // under that model. Two independent arithmetics over the same wire usage.
  const sdkRows: string[] = [];
  if (result.sdk !== undefined) {
    const recordedByModel = new Map<string, bigint>();
    for (const step of result.steps) {
      if (step.kind !== "model") continue;
      recordedByModel.set(step.name, (recordedByModel.get(step.name) ?? 0n) + BigInt(step.cost.mul(1_000_000).toFixed(0)));
    }
    for (const [key, entry] of Object.entries(result.sdk.modelUsage)) {
      const id = (entry.canonicalModel ?? key).replace(/-\d{8}$/, "");
      const recorded = Number(recordedByModel.get(id) ?? 0n) / 1_000_000;
      const delta = Math.abs(recorded - entry.costUSD);
      if (delta > COST_TOLERANCE) mismatches += 1;
      sdkRows.push(
        `| ${id} | ${entry.inputTokens} | ${entry.outputTokens} | ${entry.cacheReadInputTokens} | ${entry.cacheCreationInputTokens} | ${recorded.toFixed(6)} | ${entry.costUSD.toFixed(6)} | ${delta <= COST_TOLERANCE ? "ok" : "**DIFFERENT**"} |`,
      );
    }
    const sdkTotal = result.sdk.totalCostUsd;
    const runTotal = Number(runMicro) / 1_000_000;
    if (Math.abs(sdkTotal - runTotal) > COST_TOLERANCE) mismatches += 1;
    sdkRows.push("", `SDK total_cost_usd: ${sdkTotal.toFixed(6)} · run costTotal: ${runTotal.toFixed(6)} · turns: ${result.sdk.numTurns} · ${Math.abs(sdkTotal - runTotal) <= COST_TOLERANCE ? "equal" : "**DIFFERENT**"}`);
  }

  console.log(
    [
      "# Relay runtime spike — proof 1, live",
      "",
      `- run at: ${new Date().toISOString()}`,
      `- credential: ${credential} · transport: ${transportFor(credential)} (run: ${result.transport})`,
      `- model: ${MODEL}`,
      `- ai: ${await version("ai")} · @ai-sdk/anthropic: ${await version("@ai-sdk/anthropic")} · ai-sdk-provider-claude-code: ${await bridgeVersion()}`,
      `- price table sha256: ${PRICE_TABLE_SHA256}`,
      `- run: ${result.run.id} (${result.run.status}) · steps: ${result.steps.length} · replayed tool calls: ${result.replayedToolCalls}`,
      `- wall clock: ${Date.now() - started} ms`,
      `- answer: ${JSON.stringify(result.object)}`,
      "",
      "| step | kind | tokensIn | tokensOut | cached | reasoning | recorded cost | table cost | verdict |",
      "|---|---|---|---|---|---|---|---|---|",
      ...rows,
      "",
      `costTotal: ${result.run.costTotal.toString()} · steps summed: ${(Number(summedMicro) / 1_000_000).toFixed(6)} · ${summedMicro === runMicro ? "equal" : "**DIFFERENT**"}`,
      ...(sdkRows.length === 0
        ? []
        : [
            "",
            "Agent SDK reconciliation (the SDK's `modelUsage`, priced by the subprocess, against the rows recorded under each model):",
            "",
            "| model | sdk in | sdk out | sdk cacheRead | sdk cacheWrite | recorded cost | sdk costUSD | verdict |",
            "|---|---|---|---|---|---|---|---|",
            ...sdkRows,
          ]),
      "",
      mismatches === 0 ? "**PASS** — every row equals the response." : `**FAIL** — ${mismatches} mismatch(es) above.`,
    ].join("\n"),
  );

  return mismatches === 0 ? 0 : 1;
}

/**
 * Anthropic's `usage` block, as the Messages API sends it.
 *
 * Named here rather than imported: these are the provider's wire names, and the
 * point of this script is to compare the row against them without going back
 * through the conversion that produced the row.
 */
type RawUsage = {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_creation?: { ephemeral_1h_input_tokens?: number | null } | null;
  output_tokens_details?: { thinking_tokens?: number | null } | null;
};

function fromWire(raw: RawUsage): {
  tokensIn: number;
  tokensInUncached: number;
  tokensCacheRead: number;
  tokensCacheWrite: number;
  tokensCacheWrite1h: number;
  tokensOut: number;
  tokensReasoning: number;
} {
  const uncached = raw.input_tokens ?? 0;
  const cacheRead = raw.cache_read_input_tokens ?? 0;
  const cacheWrite = raw.cache_creation_input_tokens ?? 0;
  return {
    // Anthropic's `input_tokens` EXCLUDES the cache figures; the SDK's
    // `inputTokens` is the sum of all three, and that is what the column holds.
    tokensIn: uncached + cacheRead + cacheWrite,
    tokensInUncached: uncached,
    tokensCacheRead: cacheRead,
    tokensCacheWrite: cacheWrite,
    tokensCacheWrite1h: raw.cache_creation?.ephemeral_1h_input_tokens ?? 0,
    tokensOut: raw.output_tokens ?? 0,
    tokensReasoning: raw.output_tokens_details?.thinking_tokens ?? 0,
  };
}

/** The bridge's version, read through the vendored package. */
async function bridgeVersion(): Promise<string> {
  const manifest = (await import("../../vendor/claude-code-bridge/node_modules/ai-sdk-provider-claude-code/package.json", {
    with: { type: "json" },
  })) as { default: { version: string } };
  return manifest.default.version;
}

async function version(pkg: string): Promise<string> {
  const manifest = (await import(`${pkg}/package.json`, { with: { type: "json" } })) as {
    default: { version: string };
  };
  return manifest.default.version;
}

try {
  process.exitCode = await main();
} catch (error) {
  // Printed whole, not scrubbed: this script is run by hand by Benny-san on a
  // machine that already holds the credential, and a refused subscription token
  // is decision D2 — the API's own words are the evidence that decision needs.
  console.error("FAILED");
  console.error(error);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
