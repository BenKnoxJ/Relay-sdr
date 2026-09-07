import { describe, expect, it } from "vitest";

import { findingsFor, lintFixture } from "./lintFixture";

const RULE = "no-restricted-syntax";

const CTX = "type Ctx = { prisma: { person: { delete: (a: unknown) => void; deleteMany: (a: unknown) => void } } };\n";

// "Nothing is deleted; states change" (master doc §25, rule 1) is enforced on
// call shape, not on client name. These cases pin both halves of that: the
// shapes it must catch, and the standard-library calls it must leave alone.
describe("Prisma delete ban", () => {
  it("@proof catches a delete through an aliased client", async () => {
    const findings = await lintFixture(
      "src/lib/x.ts",
      `${CTX}export function run(ctx: Ctx) {\n  const client = ctx.prisma;\n  client.person.delete({ where: { id: "1" } });\n}\n`,
    );

    expect(findingsFor(findings, RULE)).toHaveLength(1);
  });

  it("@proof catches the direct and nested client shapes", async () => {
    for (const call of [
      "ctx.prisma.person.delete({})",
      "ctx.prisma.person.deleteMany({})",
      "tx.person.delete({})",
      "db.person.deleteMany({})",
      "anythingAtAll.person.delete({})",
    ]) {
      const findings = await lintFixture(
        "src/lib/x.ts",
        `declare const ctx: any;\ndeclare const tx: any;\ndeclare const db: any;\ndeclare const anythingAtAll: any;\nexport function run() {\n  ${call};\n}\n`,
      );

      expect(findingsFor(findings, RULE), call).toHaveLength(1);
    }
  });

  it("@proof still fires when the model shares a name with a common object", async () => {
    // The `:not(...)` allowlist sits in the model position, so anything on it
    // is a model the rule stops checking. These four are plausible model names
    // and must NOT be exempt.
    for (const model of ["cache", "set", "map", "params"]) {
      const findings = await lintFixture(
        "src/lib/x.ts",
        `declare const prisma: any;\nexport function run() {\n  prisma.${model}.deleteMany({});\n}\n`,
      );

      expect(findingsFor(findings, RULE), model).toHaveLength(1);
    }
  });

  it("@proof catches a computed property access", async () => {
    const findings = await lintFixture(
      "src/lib/x.ts",
      'declare const p: any;\nexport function run() {\n  p.person["delete"]({});\n}\n',
    );

    expect(findingsFor(findings, RULE)).toHaveLength(1);
  });

  it("@proof catches the delete being handed to something else, not only called", async () => {
    // Passing the delegate method on is the same capability with an extra hop.
    const findings = await lintFixture(
      "src/lib/x.ts",
      "declare const p: any;\nexport function run() {\n  queueMicrotask(p.person.delete);\n}\n",
    );

    expect(findingsFor(findings, RULE)).toHaveLength(1);
  });

  it("stays quiet on the standard library", async () => {
    const findings = await lintFixture(
      "src/lib/x.ts",
      [
        "export function run(key: string) {",
        "  const m = new Map<string, string>();",
        "  m.delete(key);",
        "  new Map<string, string>().delete(key);",
        "  const s = new Set<string>();",
        "  s.delete(key);",
        "  const req = { headers: new Headers() };",
        "  req.headers.delete(key);",
        '  const url = new URL("https://example.test/?a=1");',
        "  url.searchParams.delete(key);",
        "  const body = { formData: new FormData() };",
        "  body.formData.delete(key);",
        "}",
      ].join("\n"),
    );

    expect(findingsFor(findings, RULE)).toHaveLength(0);
  });

  it("is enforced in the app and server layers too, not only in lib", async () => {
    for (const file of ["src/app/x.ts", "src/server/api/x.ts", "src/worker/x.ts"]) {
      const findings = await lintFixture(
        file,
        `declare const ctx: any;\nexport function run() {\n  ctx.prisma.person.delete({});\n}\n`,
      );

      expect(findingsFor(findings, RULE), file).toHaveLength(1);
    }
  });

  it("exempts the retention job, which writes an Event instead", async () => {
    const findings = await lintFixture(
      "src/lib/jobs/retention.ts",
      `${CTX}export function run(ctx: Ctx) {\n  ctx.prisma.person.deleteMany({});\n}\n`,
    );

    expect(findingsFor(findings, RULE)).toHaveLength(0);
  });
});
