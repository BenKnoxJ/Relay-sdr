import { describe, expect, it } from "vitest";

import { findingsFor, lintFixture } from "./lintFixture";

const RULE = "no-restricted-syntax";

const DECLS = "declare const prisma: any;\ndeclare const ctx: any;\ndeclare const tx: any;\n";

// "A state change and its Event commit in one transaction" (master doc §25,
// rule 4) only holds if there is one write path. The lint is what makes that a
// property of the repository rather than a convention someone remembers.
describe("Prisma write-path ban", () => {
  it("@proof stops a write outside the repository layer", async () => {
    for (const call of [
      "prisma.user.create({})",
      "prisma.user.createMany({})",
      "prisma.user.update({})",
      "prisma.user.updateMany({})",
      "prisma.user.upsert({})",
      "ctx.prisma.connectedAccount.create({})",
      "tx.job.update({})",
    ]) {
      const findings = await lintFixture("src/app/x.ts", `${DECLS}export function run() {\n  ${call};\n}\n`);

      expect(findingsFor(findings, RULE), call).toHaveLength(1);
    }
  });

  it("@proof stops the computed spelling too", async () => {
    const findings = await lintFixture(
      "src/app/x.ts",
      `${DECLS}export function run() {\n  prisma.user["create"]({});\n}\n`,
    );

    expect(findingsFor(findings, RULE)).toHaveLength(1);
  });

  it("@proof stops raw SQL outside the repository layer, in both spellings", async () => {
    for (const call of [
      "prisma.$executeRaw`UPDATE users SET name = 'x'`",
      'prisma.$executeRawUnsafe("UPDATE users SET name = \'x\'")',
      "prisma.$queryRaw`SELECT 1`",
      'prisma.$queryRawUnsafe("SELECT 1")',
      // The computed twin. Without its own selector this is the cheapest
      // escape in the file, because it needs no aliasing and no destructuring.
      'prisma["$executeRawUnsafe"]("UPDATE users SET name = \'x\'")',
      'ctx.prisma["$queryRawUnsafe"]("SELECT 1")',
    ]) {
      const findings = await lintFixture("src/app/x.ts", `${DECLS}export function run() {\n  ${call};\n}\n`);

      expect(findingsFor(findings, RULE), call).toHaveLength(1);
    }
  });

  it("is enforced in the server, lib and worker layers too", async () => {
    for (const file of ["src/server/api/x.ts", "src/lib/x.ts", "src/worker/x.ts"]) {
      const findings = await lintFixture(file, `${DECLS}export function run() {\n  prisma.user.create({});\n}\n`);

      expect(findingsFor(findings, RULE), file).toHaveLength(1);
    }
  });

  it("@proof allows writes in the repository layer and the queue", async () => {
    for (const file of ["src/lib/repo/mutate.ts", "src/lib/repo/nested/x.ts", "src/lib/jobs/queue.ts"]) {
      const findings = await lintFixture(
        file,
        `${DECLS}export function run() {\n  tx.event.create({});\n  prisma.$executeRawUnsafe("SELECT 1");\n}\n`,
      );

      expect(findingsFor(findings, RULE), file).toHaveLength(0);
    }
  });

  it("keeps the delete ban in force inside the repository layer", async () => {
    // The write carve-out drops one rule, not both: nothing is deleted, and
    // `src/lib/repo` is not an exception to that.
    const findings = await lintFixture(
      "src/lib/repo/mutate.ts",
      `${DECLS}export function run() {\n  prisma.person.delete({});\n}\n`,
    );

    expect(findingsFor(findings, RULE)).toHaveLength(1);
  });

  it("keeps the app/worker boundary in force inside the repository layer", async () => {
    const findings = await lintFixture(
      "src/lib/repo/mutate.ts",
      'export async function run() {\n  await import("next/headers");\n}\n',
    );

    expect(findings.some((finding) => /master doc §18/.test(finding.message))).toBe(true);
  });

  it("stays quiet on ordinary two-level method calls", async () => {
    // The selector matches a Prisma call shape, and plenty of innocent code has
    // the same one. These are the near misses worth pinning so the rule is not
    // quietly widened later.
    const findings = await lintFixture(
      "src/app/x.ts",
      [
        "declare const state: { form: { update: (v: string) => void } };",
        "declare const hash: { digest: () => string; update: (v: string) => void };",
        "export function run(value: string) {",
        "  state.form.update(value);",
        "  hash.update(value);",
        "}",
      ].join("\n"),
    );

    // `state.form.update` is a two-level access and IS caught: the rule is a
    // name-shape heuristic. `hash.update` is not, because its receiver is an
    // identifier rather than a member access.
    const caught = findingsFor(findings, RULE);
    expect(caught).toHaveLength(1);
    expect(caught[0]?.line).toBe(4);
  });
});
