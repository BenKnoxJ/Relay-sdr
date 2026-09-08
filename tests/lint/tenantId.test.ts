import { describe, expect, it } from "vitest";

import { findingsFor, lintFixture } from "./lintFixture";

const RULE = "no-restricted-syntax";

/**
 * The multi-tenancy rule, as a property of the repository rather than a habit:
 * the org a request writes into comes from the session, never from the request
 * body. Sentinel raised it on PR #3 and it was deferred for want of a caller;
 * Task 8 is the first caller, so this is the check.
 */
describe("tenant id ban", () => {
  it("@proof blocks an orgId taken straight off request input", async () => {
    const findings = await lintFixture(
      "src/server/api/routers/thing.ts",
      "declare const input: { orgId: string };\n" +
        "declare function mutate(db: unknown, m: unknown): Promise<void>;\n" +
        "export const run = () => mutate(null, { orgId: input.orgId, kind: 'org.created' });\n",
    );

    expect(findingsFor(findings, RULE)).toHaveLength(1);
  });

  it("@proof blocks it one level down, and in a read as well as a write", async () => {
    for (const source of [
      "mutate(null, { orgId: input.body.orgId })",
      "prisma.user.findMany({ where: { orgId: input.orgId } })",
      "prisma.user.findMany({ where: { orgId: input.filter.orgId } })",
    ]) {
      const findings = await lintFixture(
        "src/server/api/routers/thing.ts",
        "declare const input: any;\ndeclare const prisma: any;\n" +
          "declare function mutate(db: unknown, m: unknown): unknown;\n" +
          `export const run = () => ${source};\n`,
      );

      expect(findingsFor(findings, RULE), source).toHaveLength(1);
    }
  });

  it("@proof blocks an Event actor named by the caller", async () => {
    for (const source of [
      "mutate(null, { orgId: ctx.orgId, actor: { kind: 'user', userId: input.userId } })",
      "mutate(null, { orgId: ctx.orgId, actor: { kind: 'user', userId: input.as.userId } })",
    ]) {
      const findings = await lintFixture(
        "src/server/api/routers/thing.ts",
        "declare const input: any;\ndeclare const ctx: any;\n" +
          "declare function mutate(db: unknown, m: unknown): unknown;\n" +
          `export const run = () => ${source};\n`,
      );

      expect(findingsFor(findings, RULE), source).toHaveLength(1);
    }
  });

  it("stays quiet on the values that are supposed to be used", async () => {
    for (const source of [
      // The session's org and user, which is the whole point.
      "mutate(null, { orgId: ctx.orgId, actor: { kind: 'user', userId: ctx.userId } })",
      // A rep the admin is filtering by is legitimate input (master doc §8).
      "prisma.agentRun.findMany({ where: { orgId: ctx.orgId, ownerUserId: input.userId } })",
      // The shorthand a repository function uses on its own parameter.
      "mutate(null, { orgId, actor: { kind: 'system' } })",
    ]) {
      const findings = await lintFixture(
        "src/server/api/routers/thing.ts",
        "declare const input: any;\ndeclare const ctx: any;\ndeclare const prisma: any;\n" +
          "declare const orgId: string;\n" +
          "declare function mutate(db: unknown, m: unknown): unknown;\n" +
          `export const run = () => ${source};\n`,
      );

      expect(findingsFor(findings, RULE), source).toHaveLength(0);
    }
  });

  it("@proof applies across the request-shaped layers", async () => {
    for (const file of [
      "src/server/api/routers/thing.ts",
      "src/server/auth/thing.ts",
      "src/app/api/thing/route.ts",
      "src/app/(app)/thing/actions.ts",
    ]) {
      const findings = await lintFixture(
        file,
        "declare const input: any;\ndeclare const prisma: any;\n" +
          "export const run = () => prisma.user.findMany({ where: { orgId: input.orgId } });\n",
      );

      expect(findingsFor(findings, RULE), file).toHaveLength(1);
    }
  });

  /**
   * And nowhere else. Outside the request-shaped layers `input` is an ordinary
   * function parameter, and `input.orgId` is the normal shape — this is
   * `enqueue` in `src/lib/jobs/queue.ts`, whose caller took the `orgId` off a
   * session. The rule fired on it, which is the false positive that scoped it.
   */
  it("@proof stays out of the lib and worker layers, where input is a parameter", async () => {
    for (const file of [
      "src/lib/jobs/queue.ts",
      "src/lib/repo/thing.ts",
      "src/lib/jobs/retention.ts",
      "src/worker/thing.ts",
    ]) {
      const findings = await lintFixture(
        file,
        "declare const db: any;\n" +
          "export async function enqueue(input: { orgId: string; idempotencyKey: string }) {\n" +
          "  return db.job.findUniqueOrThrow({\n" +
          "    where: { orgId_idempotencyKey: { orgId: input.orgId, idempotencyKey: input.idempotencyKey } },\n" +
          "  });\n" +
          "}\n",
      );

      expect(findingsFor(findings, RULE), file).toHaveLength(0);
    }
  });
});
