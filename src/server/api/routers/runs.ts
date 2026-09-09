import { type AgentRunStatus, type Prisma } from "@prisma/client";
import { TRPCError } from "@trpc/server";
import { z } from "zod";

import { listSteps } from "@/lib/repo/agentRuns";
import { adminProcedure, createTRPCRouter, repProcedure } from "@/server/api/trpc";

/**
 * Agent runs, read back (master doc §8 "agent runs and cost", §24 design law:
 * every run is a first-class record, and §26 item 5: the rep's questions and
 * the admin's per-kind rates from one router).
 *
 * Reads only. The write path for both tables is `src/lib/repo/agentRuns.ts`
 * and the runtime is its only caller; nothing here changes a row.
 *
 * Two scopes, and the difference between them is the whole of the access rule
 * in §8: a rep sees the runs of their own jobs and nothing else; an admin sees
 * every run in the org. "Own" is `AgentRun.orgId = ctx.orgId` **and**
 * `AgentRun.job.ownerUserId = ctx.userId`. Both come from the session — the
 * lint refuses an `orgId` off `input` — so nothing on this router can be
 * pointed at another rep's runs by a request body. A run the caller cannot see
 * answers `NOT_FOUND`, never `FORBIDDEN`: telling the two apart is how an id
 * becomes an oracle for what other reps and other orgs hold.
 *
 * What a step carries over the wire is also a boundary. A rep gets the meter
 * (kind, name, tokens, cost, times) and never `input`, `output` or
 * `providerMeta`: prompts and raw provider blocks stay off the wire. An admin
 * additionally gets `providerMeta.rawUsage`, which is the one block a cost
 * figure can be argued with, and still not the prompt.
 *
 * No page reads this in Phase 1. The bench and the campaign page's "what has
 * this cost" line are the callers it is shaped for; `runs.cost` takes no
 * `campaignId` yet — see the note on that procedure.
 */

/** A page of runs: twenty by default, fifty at most. */
const PAGE_DEFAULT = 20;
const PAGE_MAX = 50;

const RUN_STATUSES = ["running", "done", "failed"] as const satisfies readonly AgentRunStatus[];

/**
 * Halt reason, derived.
 *
 * Task 6d's typed halt vocabulary (`src/lib/agents/halts.ts`, stop and fault)
 * is not merged. Until it is, the reason is read off the `error` column, which
 * `runAgent` writes as `<reason>: <summary> (<detail>)` with the reason drawn
 * from its `FailureReason` union: the leading token, before the first `:` or
 * space, lower-cased. A failed run with no error text is `"error"`.
 *
 * `null` for a run that has not halted: `done` by the brief, and `running`
 * because a run still going has no halt reason yet, and reporting `"error"`
 * for it would count every in-flight run as a fault in `adminRates`.
 *
 * One function, exported, so 6d replaces the derivation here and the wire
 * shape (`halt: string | null`) does not move.
 */
export function haltOf(status: AgentRunStatus, error: string | null): string | null {
  if (status !== "failed") return null;
  const token = (error ?? "").split(/[:\s]/, 1)[0]?.trim().toLowerCase() ?? "";
  return token === "" ? "error" : token;
}

/**
 * The cursor is the sort key, `(startedAt desc, id desc)`, carried as one
 * opaque string. ISO time first, then the id, joined on `|` — which neither an
 * ISO timestamp nor a cuid contains, so the split is unambiguous.
 */
const cursorSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T[0-9:.]+Z\|[A-Za-z0-9_-]+$/)
  .transform((raw) => {
    const at = raw.indexOf("|");
    const startedAt = new Date(raw.slice(0, at));
    if (Number.isNaN(startedAt.getTime())) throw new Error("bad cursor");
    return { startedAt, id: raw.slice(at + 1) };
  });

type Cursor = z.output<typeof cursorSchema>;

function encodeCursor(row: { startedAt: Date; id: string }): string {
  return `${row.startedAt.toISOString()}|${row.id}`;
}

/** Everything after the cursor in `(startedAt desc, id desc)` order. */
function afterCursor(cursor: Cursor | undefined): Prisma.AgentRunWhereInput {
  if (cursor === undefined) return {};
  return {
    OR: [
      { startedAt: { lt: cursor.startedAt } },
      { startedAt: cursor.startedAt, id: { lt: cursor.id } },
    ],
  };
}

const ORDER = [{ startedAt: "desc" }, { id: "desc" }] as const satisfies Prisma.AgentRunOrderByWithRelationInput[];

/** What one run reads as on the wire, for either role. */
const runSelect = {
  id: true,
  jobId: true,
  kind: true,
  model: true,
  status: true,
  startedAt: true,
  finishedAt: true,
  costTotal: true,
  error: true,
  _count: { select: { steps: true } },
} satisfies Prisma.AgentRunSelect;

type RunRow = Prisma.AgentRunGetPayload<{ select: typeof runSelect }>;

/** The same, plus who owns the job: the admin's view is the rep's view with a name on it. */
const adminSelect = {
  ...runSelect,
  job: { select: { ownerUserId: true, ownerUser: { select: { email: true } } } },
} satisfies Prisma.AgentRunSelect;

/**
 * Decimal to string, six places: the column is `Decimal(12,6)` and
 * `formatMicroDollars` in `src/lib/agents/pricing.ts` writes six, so a
 * figure reads back exactly as the runtime wrote it. Never a float: money.
 */
function money(value: Prisma.Decimal | null | undefined): string {
  return (value ?? 0).toFixed(6);
}

function shapeRun(row: RunRow) {
  return {
    id: row.id,
    jobId: row.jobId,
    kind: row.kind,
    model: row.model,
    status: row.status,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    costTotal: money(row.costTotal),
    stepCount: row._count.steps,
    halt: haltOf(row.status, row.error),
  };
}

/** The rep's meter: what a step spent, and never what it said. */
function shapeStep(step: Awaited<ReturnType<typeof listSteps>>[number]) {
  return {
    id: step.id,
    index: step.index,
    kind: step.kind,
    name: step.name,
    tokensIn: step.tokensIn,
    tokensOut: step.tokensOut,
    tokensCached: step.tokensCached,
    tokensReasoning: step.tokensReasoning,
    cost: money(step.cost),
    startedAt: step.startedAt,
    finishedAt: step.finishedAt,
  };
}

/**
 * The one provider block an admin may see. Picked by key off the JSON rather
 * than passed through: `providerMeta` also carries request ids and whatever
 * else the transport chose to keep, and the wire shape should not widen
 * because a provider started returning more.
 */
function rawUsageOf(providerMeta: Prisma.JsonValue | null): Prisma.JsonValue | null {
  if (providerMeta === null || typeof providerMeta !== "object" || Array.isArray(providerMeta)) {
    return null;
  }
  return providerMeta.rawUsage ?? null;
}

const pageInput = z.object({
  cursor: cursorSchema.optional(),
  limit: z.number().int().min(1).max(PAGE_MAX).default(PAGE_DEFAULT),
  kind: z.string().trim().min(1).optional(),
  jobId: z.string().trim().min(1).optional(),
});

/** The query a page is read with: scope, order and the extra row, in one place. */
type PageArgs = {
  where: Prisma.AgentRunWhereInput;
  orderBy: typeof ORDER;
  take: number;
};

/**
 * Cursor paging over `(startedAt desc, id desc)`.
 *
 * Takes the read as a function rather than a `select`, so the two callers keep
 * their own row types and this stays typed without a cast: Prisma's payload
 * type over a generic `select` does not narrow to the sort key.
 */
async function page<Row extends { startedAt: Date; id: string }>(
  where: Prisma.AgentRunWhereInput,
  input: { cursor?: Cursor; limit: number },
  read: (args: PageArgs) => Promise<Row[]>,
): Promise<{ items: Row[]; nextCursor: string | null }> {
  // One more than the page: the extra row is how "is there another page" is
  // answered without a second count query.
  const rows = await read({
    where: { AND: [where, afterCursor(input.cursor)] },
    orderBy: ORDER,
    take: input.limit + 1,
  });
  const items = rows.slice(0, input.limit);
  const last = items[items.length - 1];
  const nextCursor = rows.length > input.limit && last !== undefined ? encodeCursor(last) : null;
  return { items, nextCursor };
}

export const runsRouter = createTRPCRouter({
  /** The caller's own runs, newest first. */
  list: repProcedure.input(pageInput.default({})).query(async ({ ctx, input }) => {
    const where: Prisma.AgentRunWhereInput = {
      orgId: ctx.orgId,
      job: { ownerUserId: ctx.userId },
      ...(input.kind === undefined ? {} : { kind: input.kind }),
      ...(input.jobId === undefined ? {} : { jobId: input.jobId }),
    };
    const { items, nextCursor } = await page(where, input, (args) =>
      ctx.prisma.agentRun.findMany({ ...args, select: runSelect }),
    );
    return { items: items.map(shapeRun), nextCursor };
  }),

  /** One of the caller's own runs, with its steps. */
  get: repProcedure.input(z.object({ id: z.string().min(1) }).strict()).query(async ({ ctx, input }) => {
    const row = await ctx.prisma.agentRun.findFirst({
      where: { id: input.id, orgId: ctx.orgId, job: { ownerUserId: ctx.userId } },
      select: runSelect,
    });
    if (row === null) {
      // Another rep's, another org's, or nobody's: one answer for all three.
      throw new TRPCError({ code: "NOT_FOUND" });
    }
    const steps = await listSteps(ctx.prisma, { orgId: ctx.orgId, runId: row.id });
    return { ...shapeRun(row), steps: steps.map(shapeStep) };
  }),

  /**
   * What the caller's runs have cost, in total and by kind.
   *
   * Failed and running runs count: tokens spent before a failure were still
   * spent, and a running run's `costTotal` is zero until it closes, so the
   * figure never overstates.
   *
   * No `campaignId` yet, on purpose. The campaign page's "what has this cost"
   * line wants one, and `Job.campaignId` arrives with Task 6d. Accepting the
   * argument now and ignoring it would hand that line an org-wide figure
   * labelled as a campaign's; a caller that cannot compile until 6d lands is
   * the honest failure. 6d adds the argument and the `job.campaignId` filter
   * here, and the shape of the answer does not change.
   */
  cost: repProcedure
    .input(z.object({ since: z.date().optional() }).strict().default({}))
    .query(async ({ ctx, input }) => {
      const groups = await ctx.prisma.agentRun.groupBy({
        by: ["kind"],
        where: {
          orgId: ctx.orgId,
          job: { ownerUserId: ctx.userId },
          ...(input.since === undefined ? {} : { startedAt: { gte: input.since } }),
        },
        _sum: { costTotal: true },
        _count: { _all: true },
        orderBy: { kind: "asc" },
      });
      let total = 0n;
      const byKind = groups.map((group) => {
        const sum = money(group._sum.costTotal);
        total += microOf(sum);
        return { kind: group.kind, total: sum, runs: group._count._all };
      });
      return { total: moneyOfMicro(total), byKind };
    }),

  /** Every run in the org, newest first, with who owns it. */
  adminList: adminProcedure
    .input(
      pageInput
        .extend({
          ownerUserId: z.string().trim().min(1).optional(),
          status: z.enum(RUN_STATUSES).optional(),
        })
        .default({}),
    )
    .query(async ({ ctx, input }) => {
      const where: Prisma.AgentRunWhereInput = {
        orgId: ctx.orgId,
        ...(input.kind === undefined ? {} : { kind: input.kind }),
        ...(input.jobId === undefined ? {} : { jobId: input.jobId }),
        ...(input.status === undefined ? {} : { status: input.status }),
        ...(input.ownerUserId === undefined ? {} : { job: { ownerUserId: input.ownerUserId } }),
      };
      const { items, nextCursor } = await page(where, input, (args) =>
        ctx.prisma.agentRun.findMany({ ...args, select: adminSelect }),
      );
      return {
        items: items.map((row) => ({
          ...shapeRun(row),
          ownerUserId: row.job.ownerUserId,
          ownerEmail: row.job.ownerUser?.email ?? null,
        })),
        nextCursor,
      };
    }),

  /** One run in the org, with its steps and the provider's raw usage. */
  adminGet: adminProcedure
    .input(z.object({ id: z.string().min(1) }).strict())
    .query(async ({ ctx, input }) => {
      const row = await ctx.prisma.agentRun.findFirst({
        where: { id: input.id, orgId: ctx.orgId },
        select: adminSelect,
      });
      if (row === null) throw new TRPCError({ code: "NOT_FOUND" });
      const steps = await listSteps(ctx.prisma, { orgId: ctx.orgId, runId: row.id });
      return {
        ...shapeRun(row),
        ownerUserId: row.job.ownerUserId,
        ownerEmail: row.job.ownerUser?.email ?? null,
        steps: steps.map((step) => ({ ...shapeStep(step), rawUsage: rawUsageOf(step.providerMeta) })),
      };
    }),

  /**
   * Per kind over `since`: how many ran, how many finished, how many failed,
   * and what the failures halted on.
   *
   * `runs` counts every status, so `runs - done - failed` is what is still
   * going. Halts are counted over failed runs only, by `haltOf`.
   */
  adminRates: adminProcedure
    .input(z.object({ since: z.date().optional() }).strict().default({}))
    .query(async ({ ctx, input }) => {
      const where: Prisma.AgentRunWhereInput = {
        orgId: ctx.orgId,
        ...(input.since === undefined ? {} : { startedAt: { gte: input.since } }),
      };
      const [counts, failures] = await Promise.all([
        ctx.prisma.agentRun.groupBy({
          by: ["kind", "status"],
          where,
          _count: { _all: true },
        }),
        // The error column of failed runs only: the counts above already say
        // how many, and this is the smallest read that says why.
        ctx.prisma.agentRun.findMany({
          where: { ...where, status: "failed" },
          select: { kind: true, status: true, error: true },
        }),
      ]);

      const byKind = new Map<string, { runs: number; done: number; failed: number; halts: Map<string, number> }>();
      const kindOf = (kind: string) => {
        let entry = byKind.get(kind);
        if (entry === undefined) {
          entry = { runs: 0, done: 0, failed: 0, halts: new Map() };
          byKind.set(kind, entry);
        }
        return entry;
      };
      for (const group of counts) {
        const entry = kindOf(group.kind);
        entry.runs += group._count._all;
        if (group.status === "done") entry.done += group._count._all;
        if (group.status === "failed") entry.failed += group._count._all;
      }
      for (const run of failures) {
        const reason = haltOf(run.status, run.error) ?? "error";
        const halts = kindOf(run.kind).halts;
        halts.set(reason, (halts.get(reason) ?? 0) + 1);
      }

      return [...byKind.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([kind, entry]) => ({
          kind,
          runs: entry.runs,
          done: entry.done,
          failed: entry.failed,
          haltRates: [...entry.halts.entries()]
            .sort(([a, x], [b, y]) => y - x || a.localeCompare(b))
            .map(([reason, count]) => ({ reason, count })),
        }));
    }),
});

/**
 * Six-place strings added as integers of micro-dollars, never as floats. The
 * same arithmetic `pricing.ts` does, kept local so the router does not import
 * the agents layer (`src/lib/agents/**` is not this task's to lean on).
 */
function microOf(six: string): bigint {
  const negative = six.startsWith("-");
  const [whole = "0", fraction = ""] = (negative ? six.slice(1) : six).split(".");
  const micro = BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, "0").slice(0, 6));
  return negative ? -micro : micro;
}

function moneyOfMicro(micro: bigint): string {
  const negative = micro < 0n;
  const absolute = negative ? -micro : micro;
  return `${negative ? "-" : ""}${absolute / 1_000_000n}.${(absolute % 1_000_000n).toString().padStart(6, "0")}`;
}
