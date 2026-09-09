/**
 * Spike proof 1, live: the row equals the wire.
 *
 * One `echo` run against the real Messages API, then a table comparing every
 * recorded step to the provider's own usage and every recorded cost to the pinned
 * price table. Exits non-zero on any mismatch, so it is a gate and not a report.
 *
 * It is also the script that answers decision **D2**. Relay's agents bill to the
 * Claude subscription (decision, 2026-09-08), and the token has to reach the API
 * through the AI SDK provider because §24 forbids `claude -p` in the worker. That
 * path has never been exercised: if Anthropic refuses a subscription token for a
 * product worker, this is where it says so, and the answer goes to Benny-san
 * rather than being worked around. There is no fallback to the Agent SDK here and
 * there must not be one.
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
import { credentialKind, makeModel } from "@/lib/agents/provider";
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
      | { usage?: Record<string, number>; rawUsage?: RawUsage | null }
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
      tokenProblems.push("no raw provider usage stored; nothing to compare the row against");
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
    }

    const expected = cost(
      {
        tokensIn: usage.tokensIn ?? 0,
        tokensInUncached: usage.tokensInUncached ?? 0,
        tokensCacheRead: usage.tokensCacheRead ?? 0,
        tokensCacheWrite: usage.tokensCacheWrite ?? 0,
        tokensOut: usage.tokensOut ?? 0,
      },
      MODEL,
    );
    const delta = Math.abs(Number(step.cost.toString()) - Number(expected));
    if (delta > COST_TOLERANCE) tokenProblems.push(`cost ${step.cost.toString()} vs ${expected}`);
    if ((step.providerMeta as { providerMetadata?: unknown } | null)?.providerMetadata === undefined) {
      tokenProblems.push("providerMetadata missing");
    }

    if (tokenProblems.length > 0) mismatches += 1;
    rows.push(
      `| ${step.index} | model | ${step.tokensIn} | ${step.tokensOut} | ${step.tokensCached} | ${step.tokensReasoning} | ${step.cost.toString()} | ${expected} | ${tokenProblems.length === 0 ? "ok" : `**${tokenProblems.join("; ")}**`} |`,
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

  console.log(
    [
      "# Relay runtime spike — proof 1, live",
      "",
      `- run at: ${new Date().toISOString()}`,
      `- credential: ${credential}`,
      `- model: ${MODEL}`,
      `- ai: ${await version("ai")} · @ai-sdk/anthropic: ${await version("@ai-sdk/anthropic")}`,
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
  output_tokens_details?: { thinking_tokens?: number | null } | null;
};

function fromWire(raw: RawUsage): {
  tokensIn: number;
  tokensInUncached: number;
  tokensCacheRead: number;
  tokensCacheWrite: number;
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
    tokensOut: raw.output_tokens ?? 0,
    tokensReasoning: raw.output_tokens_details?.thinking_tokens ?? 0,
  };
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
