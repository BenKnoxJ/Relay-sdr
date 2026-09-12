import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { prisma } from "@/lib/db";

import { listColumns, listTables, listUniqueIndexes, resetDatabase } from "./harness";

// The migration is the artefact under test, not the Prisma schema: what the
// database ends up shaped like is what every later task builds on. So this
// file rebuilds the schema from empty and then reads `information_schema`,
// rather than trusting `schema.prisma` to describe what was applied.

const EXPECTED_TABLES = [
  "agent_run_steps",
  "agent_runs",
  "campaigns",
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

describe("foundations", () => {
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

  // Master doc §25, rule 3. A semantically-derived key ("send touch 1 to this
  // person") can legitimately repeat across tenants, so each of these is unique
  // within the org and nowhere else. Read from `pg_index` rather than from the
  // schema file: `prisma migrate diff` only proves the schema and the migration
  // agree with each other, which is how a leftover global `@unique` on
  // `tool_key` survived the first round of this task.
  const ORG_SCOPED_KEYS: Array<{ table: string; column: string; index: string[] }> = [
    { table: "jobs", column: "idempotency_key", index: ["org_id", "idempotency_key"] },
    { table: "side_effects", column: "key", index: ["org_id", "key"] },
    { table: "agent_run_steps", column: "tool_key", index: ["org_id", "tool_key"] },
    { table: "product_facts_versions", column: "version", index: ["org_id", "product", "version"] },
    { table: "campaigns", column: "start_request_id", index: ["org_id", "start_request_id"] },
  ];

  for (const { table, column, index } of ORG_SCOPED_KEYS) {
    it(`@proof scopes ${table}.${column} to the org and nowhere wider`, async () => {
      // Matched on the key text, not the column list: a unique index over
      // `lower(tool_key)` constrains the tool key just as hard as one over the
      // bare column, and covers no column at all as far as `pg_attribute` is
      // concerned.
      const mentions = new RegExp(`\\b${column}\\b`);
      const covering = (await listUniqueIndexes(table)).filter((unique) =>
        mentions.test(unique.keys),
      );

      // Exactly one, and it is the composite: a second unique index over the
      // same column — the bare `(column)` one Prisma writes for a field-level
      // `@unique` — puts the constraint back across the whole table.
      expect(covering.map((unique) => unique.columns)).toEqual([index]);
    });
  }

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

/**
 * The campaigns migration. Its two hand-written rules are CHECKs the Prisma
 * schema cannot express, so they are proved by what the database refuses
 * rather than by reading the schema back.
 */
describe("campaigns", () => {
  const insertOrgUserCampaign = async () => {
    await prisma.$executeRaw`INSERT INTO orgs (id, name, updated_at) VALUES ('org_m', 'org_m', now())`;
    await prisma.$executeRaw`INSERT INTO users (id, org_id, email, updated_at) VALUES ('user_m', 'org_m', 'm@example.test', now())`;
    await prisma.$executeRaw`
      INSERT INTO campaigns (id, org_id, owner_user_id, name, brief, start_request_id, updated_at)
      VALUES ('camp_m', 'org_m', 'user_m', 'Vets', '{}'::jsonb, 'req_m', now())`;
  };
  const insertJob = (key: string, campaignId: string | null, briefVersion: number | null) =>
    prisma.$executeRaw`
      INSERT INTO jobs (id, org_id, kind, idempotency_key, input, campaign_id, brief_version, updated_at)
      VALUES (${key}, 'org_m', 'research', ${key}, '{}'::jsonb, ${campaignId}, ${briefVersion}::integer, now())`;

  it("gives a job a campaign and a brief version together or not at all", async () => {
    await insertOrgUserCampaign();

    await expect(insertJob("both", "camp_m", 1)).resolves.toBe(1);
    await expect(insertJob("neither", null, null)).resolves.toBe(1);
    await expect(insertJob("campaign-only", "camp_m", null)).rejects.toThrow(/jobs_campaign_brief_version_together/);
    await expect(insertJob("version-only", null, 1)).rejects.toThrow(/jobs_campaign_brief_version_together/);
    await expect(insertJob("version-zero", "camp_m", 0)).rejects.toThrow(/jobs_brief_version_positive/);
  });

  it("stores no campaign state: where a campaign is, is derived", async () => {
    expect(await listColumns("campaigns")).toEqual([
      "brief",
      "brief_version",
      "created_at",
      "id",
      "name",
      "org_id",
      "owner_user_id",
      "start_request_id",
      "updated_at",
    ]);
  });
});
