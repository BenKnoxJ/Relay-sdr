import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { prisma } from "@/lib/db";

import { listColumns, listTables, resetDatabase } from "./harness";

// The migration is the artefact under test, not the Prisma schema: what the
// database ends up shaped like is what every later task builds on. So this
// file rebuilds the schema from empty and then reads `information_schema`,
// rather than trusting `schema.prisma` to describe what was applied.

const EXPECTED_TABLES = [
  "agent_run_steps",
  "agent_runs",
  "connected_accounts",
  "events",
  "jobs",
  "oauth_states",
  "orgs",
  "product_facts_versions",
  "side_effects",
  "users",
];

/** `Org` is the tenant itself, so it carries no `org_id` pointing at another. */
const NO_ORG_ID = new Set(["orgs"]);

/** Prisma's own bookkeeping table, not part of the data model. */
const PRISMA_INTERNAL = "_prisma_migrations";

let migrateOutput = "";

beforeAll(async () => {
  migrateOutput = await resetDatabase();
}, 120_000);

afterAll(async () => {
  await prisma.$disconnect();
});

describe("0001_foundations", () => {
  it("@proof migrates a fresh database cleanly", () => {
    // `migrate deploy` exits non-zero on failure, so reaching here is most of
    // the claim; the assertion pins that it actually applied something rather
    // than finding nothing to do on an already-migrated database.
    expect(migrateOutput).toMatch(/Applying migration `\d+_foundations`/);
    expect(migrateOutput).toMatch(/All migrations have been successfully applied/);
  });

  it("creates every Phase 1 table and nothing else", async () => {
    const tables = (await listTables()).filter((table) => table !== PRISMA_INTERNAL);
    expect(tables).toEqual(EXPECTED_TABLES);
  });

  it("@proof scopes every row to an org (master doc §25, rule 3)", async () => {
    const missing: string[] = [];
    for (const table of EXPECTED_TABLES) {
      if (NO_ORG_ID.has(table)) continue;
      const columns = await listColumns(table);
      if (!columns.includes("org_id")) missing.push(table);
    }
    expect(missing).toEqual([]);
  });

  it("@proof keeps events append-only: no updated_at", async () => {
    const columns = await listColumns("events");
    expect(columns).toContain("created_at");
    expect(columns).not.toContain("updated_at");
  });

  it("timestamps every other table with created_at and updated_at", async () => {
    const missing: string[] = [];
    for (const table of EXPECTED_TABLES) {
      if (table === "events") continue;
      const columns = await listColumns(table);
      if (!columns.includes("created_at")) missing.push(`${table}.created_at`);
      if (!columns.includes("updated_at")) missing.push(`${table}.updated_at`);
    }
    expect(missing).toEqual([]);
  });

  it("names columns in snake_case", async () => {
    const offenders: string[] = [];
    for (const table of EXPECTED_TABLES) {
      for (const column of await listColumns(table)) {
        if (!/^[a-z][a-z0-9_]*$/.test(column)) offenders.push(`${table}.${column}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
