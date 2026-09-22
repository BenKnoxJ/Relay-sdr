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
  "campaign_people",
  "campaigns",
  "connected_accounts",
  "contact_suppressions",
  "credit_ledger",
  "events",
  "jobs",
  "oauth_states",
  "orgs",
  "outreach_drafts",
  "outreach_events",
  "outreach_sends",
  "people",
  "product_facts_versions",
  "provider_identities",
  "rep_voices",
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
      // Append-only tables: a row that can be edited is not a record of anything.
      if (table === "events" || table === "outreach_events") continue;
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
    // `outreach_paused_at` is the rep's own switch (Relay P3), not a stage: nothing derives it.
    expect(await listColumns("campaigns")).toEqual([
      "brief",
      "brief_version",
      "created_at",
      "id",
      "name",
      "org_id",
      "outreach_paused_at",
      "owner_user_id",
      "play_id",
      "research_from_brief_version",
      "research_from_campaign_id",
      "start_request_id",
      "updated_at",
    ]);
  });

  it("reads another campaign's research at one version of it, or its own: both or neither (Relay P1)", async () => {
    // Its own org, so it does not depend on the rows the tests above wrote.
    await prisma.$executeRaw`INSERT INTO orgs (id, name, updated_at) VALUES ('org_p', 'org_p', now())`;
    await prisma.$executeRaw`INSERT INTO users (id, org_id, email, updated_at) VALUES ('user_p', 'org_p', 'p@example.test', now())`;
    await prisma.$executeRaw`
      INSERT INTO campaigns (id, org_id, owner_user_id, name, brief, start_request_id, updated_at)
      VALUES ('camp_p', 'org_p', 'user_p', 'Vets', '{}'::jsonb, 'req_p', now())`;
    const insertFrom = (id: string, from: string | null, version: number | null) =>
      prisma.$executeRaw`
        INSERT INTO campaigns (id, org_id, owner_user_id, name, brief, start_request_id, research_from_campaign_id, research_from_brief_version, play_id, updated_at)
        VALUES (${id}, 'org_p', 'user_p', 'Play', '{}'::jsonb, ${id}, ${from}, ${version}::integer, 'candidate-a', now())`;

    await expect(insertFrom("both", "camp_p", 1)).resolves.toBe(1);
    await expect(insertFrom("campaign-only", "camp_p", null)).rejects.toThrow(/campaigns_research_from_together/);
    await expect(insertFrom("version-only", null, 1)).rejects.toThrow(/campaigns_research_from_together/);
    await expect(insertFrom("version-zero", "camp_p", 0)).rejects.toThrow(/campaigns_research_from_version_positive/);
    await expect(insertFrom("no-such-source", "camp_missing", 1)).rejects.toThrow(/campaigns_research_from_campaign_id_fkey/);
  });
});

/**
 * The drafting migrations (outreach v2.1). What `schema.prisma` declares and
 * what the database holds must agree, so a later `prisma migrate dev` has
 * nothing to "fix" by dropping a guarantee.
 */
describe("sequence dates (Relay P3)", () => {
  it("adds a nullable DATE start day per person and a nullable pause instant per campaign, and nothing else", async () => {
    const columns = await prisma.$queryRaw<Array<{ table_name: string; column_name: string; data_type: string; is_nullable: string; column_default: string | null }>>`
      SELECT table_name, column_name, data_type, is_nullable, column_default FROM information_schema.columns
       WHERE table_schema = 'public' AND column_name IN ('outreach_start_on', 'outreach_paused_at')
       ORDER BY table_name, column_name`;
    expect(columns).toEqual([
      { table_name: "campaign_people", column_name: "outreach_start_on", data_type: "date", is_nullable: "YES", column_default: null },
      { table_name: "campaigns", column_name: "outreach_paused_at", data_type: "timestamp without time zone", is_nullable: "YES", column_default: null },
    ]);
  });
});

describe("tracking events (Relay P4)", () => {
  it("adds the table and a nullable phone per person, and changes no existing column", async () => {
    expect(await listColumns("outreach_events")).toEqual([
      "by_user_id",
      "call_result",
      "campaign_id",
      "campaign_person_id",
      "created_at",
      "happened_on",
      "id",
      "kind",
      "note",
      "org_id",
      "outcome",
      "seq",
      "step",
      "undoes_event_id",
    ]);
    const phone = await prisma.$queryRaw<Array<{ data_type: string; is_nullable: string; column_default: string | null }>>`
      SELECT data_type, is_nullable, column_default FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'campaign_people' AND column_name = 'phone'`;
    expect(phone).toEqual([{ data_type: "text", is_nullable: "YES", column_default: null }]);
    // Additive: the migration's only statements on existing tables add the phone column and its length check.
    const { readFileSync } = await import("node:fs");
    const sql = readFileSync("prisma/migrations/20260921180000_outreach_events/migration.sql", "utf8").replace(/--.*$/gm, "");
    expect(sql).not.toMatch(/\b(DROP|RENAME|TRUNCATE)\b|\bUPDATE\s+"|\bDELETE\s+FROM\b/i);
    expect(sql.match(/ALTER TABLE "(\w+)" (ADD|ALTER|DROP) (COLUMN|CONSTRAINT) "?(\w+)/g)?.filter((line) => !line.includes('"outreach_events"'))).toEqual([
      'ALTER TABLE "campaign_people" ADD COLUMN "phone',
      'ALTER TABLE "campaign_people" ADD CONSTRAINT "campaign_people_phone_length',
    ]);
  });

  it("@proof keeps outreach_events append-only: no updated_at, and UPDATE and DELETE are refused by the table itself", async () => {
    expect(await listColumns("outreach_events")).not.toContain("updated_at");
    const triggers = await prisma.$queryRaw<Array<{ event_manipulation: string }>>`
      SELECT event_manipulation FROM information_schema.triggers
       WHERE event_object_table = 'outreach_events' AND action_timing = 'BEFORE' ORDER BY event_manipulation`;
    expect(triggers.map((trigger) => trigger.event_manipulation)).toEqual(["DELETE", "UPDATE"]);
  });

  it("undoes a row at most once", async () => {
    expect((await listUniqueIndexes("outreach_events")).map((unique) => unique.columns)).toContainEqual(["undoes_event_id"]);
  });
});

describe("sending from Outlook (Relay P7)", () => {
  it("adds the look to users with defaults, a send per person and step, and changes no existing column", async () => {
    const look = await prisma.$queryRaw<Array<{ column_name: string; data_type: string; is_nullable: string; column_default: string | null }>>`
      SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'users' AND column_name LIKE 'email\\_%' ORDER BY column_name`;
    expect(look).toEqual([
      { column_name: "email_font", data_type: "text", is_nullable: "NO", column_default: "'Aptos'::text" },
      { column_name: "email_font_size", data_type: "integer", is_nullable: "NO", column_default: "11" },
      { column_name: "email_signature", data_type: "text", is_nullable: "NO", column_default: "''::text" },
    ]);
    expect((await listUniqueIndexes("outreach_sends")).map((unique) => unique.columns)).toContainEqual(["org_id", "campaign_person_id", "step"]);
    // Additive: nothing dropped, renamed or rewritten, and the only statements on an existing table add the look.
    const { readFileSync } = await import("node:fs");
    const sql = readFileSync("prisma/migrations/20260922090000_outlook_send/migration.sql", "utf8").replace(/--.*$/gm, "");
    expect(sql).not.toMatch(/\b(DROP|RENAME|TRUNCATE)\b|\bUPDATE\s+"|\bDELETE\s+FROM\b/i);
    expect(sql.match(/^ALTER TABLE "(\w+)"/gm)?.filter((line) => !line.includes('"outreach_sends"'))).toEqual(['ALTER TABLE "users"']);
    expect(sql.match(/^(ADD|ALTER|DROP) (COLUMN|CONSTRAINT)\s+"?(\w+)/gm)).toEqual([
      'ADD COLUMN     "email_font_size',
      'ADD COLUMN     "email_signature',
      'ADD CONSTRAINT "users_email_font_size',
      'ADD CONSTRAINT "users_email_signature_length',
    ]);
  });
});

describe("outreach drafts", () => {
  it("keeps one draft per person, touch and attempt, and one voice per rep within the org", async () => {
    expect((await listUniqueIndexes("outreach_drafts")).map((unique) => unique.columns)).toContainEqual(["org_id", "campaign_person_id", "touch", "attempt"]);
    expect((await listUniqueIndexes("rep_voices")).map((unique) => unique.columns)).toContainEqual(["org_id", "user_id"]);
  });

  it("never stores a NULL claims list: Prisma cannot read one back", async () => {
    const [column] = await prisma.$queryRaw<Array<{ is_nullable: string; column_default: string | null }>>`
      SELECT is_nullable, column_default FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'outreach_drafts' AND column_name = 'claims'`;
    expect(column).toMatchObject({ is_nullable: "NO" });
    expect(column?.column_default).toMatch(/ARRAY\[\]/);
  });
});
