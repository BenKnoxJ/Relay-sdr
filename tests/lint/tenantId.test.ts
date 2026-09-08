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

  it("applies in the lib and worker layers too, where the blocks are separate", async () => {
    for (const file of [
      "src/lib/repo/thing.ts",
      "src/lib/jobs/retention.ts",
      "src/worker/thing.ts",
      "src/lib/thing.ts",
    ]) {
      const findings = await lintFixture(
        file,
        "declare const input: any;\ndeclare const prisma: any;\n" +
          "export const run = () => prisma.user.findMany({ where: { orgId: input.orgId } });\n",
      );

      expect(findingsFor(findings, RULE), file).toHaveLength(1);
    }
  });
});
