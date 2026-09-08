import { execFileSync } from "node:child_process";
import path from "node:path";

import { prisma } from "@/lib/db";

const projectRoot = path.resolve(import.meta.dirname, "..", "..");
const prismaBin = path.join(projectRoot, "node_modules", ".bin", "prisma");

/**
 * Tables the schema does not own. `_prisma_migrations` is Prisma's own
 * bookkeeping: it has no `org_id`, and emptying it would make the next
 * `migrate deploy` replay every migration onto a populated database.
 */
const NOT_OURS = new Set(["_prisma_migrations"]);

function assertTestDatabase(): void {
  // `tests/setup.ts` already refuses a non-test database, but this file issues
  // the destructive statements. A second check next to the damage is worth the
  // lines: the guard and the thing it guards stay in the same file.
  //
  // Both variables, not just `DATABASE_URL`. The Prisma client connects on
  // `DATABASE_URL`, but `prisma migrate deploy` uses the datasource's
  // `directUrl` — so with the two pointed at different databases (which is what
  // `docs/environment.md` prescribes for a pooled production), a run would
  // rebuild the schema of one and migrate the other. `tests/setup.ts` defaults
  // `DIRECT_URL` to `DATABASE_URL`, so this only fires on an explicit override,
  // which is exactly when it is needed.
  for (const variable of ["DATABASE_URL", "DIRECT_URL"] as const) {
    const value = process.env[variable];
    if (value === undefined || value === "") {
      throw new Error(`Refusing to touch the database: ${variable} is not set.`);
    }
    const name = new URL(value).pathname.replace(/^\//, "");
    if (!name.endsWith("_test")) {
      throw new Error(
        `Refusing to reset database "${name}" (${variable}): the name must end in "_test".`,
      );
    }
  }
}

/**
 * Apply every migration. Not exported: on its own it assumes the database is
 * either empty or exactly one migration behind, which is true in CI and not
 * true on a machine that has switched branches. `resetDatabase` is the entry
 * point, and it makes that assumption hold.
 */
function migrateDeploy(): string {
  assertTestDatabase();
  return execFileSync(prismaBin, ["migrate", "deploy"], {
    cwd: projectRoot,
    env: process.env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/**
 * Rebuild the schema from empty and migrate. This is the only way to prove the
 * migration applies to a *fresh* database rather than to whatever shape the
 * last run happened to leave behind.
 */
export async function resetDatabase(): Promise<string> {
  assertTestDatabase();
  await prisma.$executeRawUnsafe('DROP SCHEMA "public" CASCADE');
  await prisma.$executeRawUnsafe('CREATE SCHEMA "public"');
  return migrateDeploy();
}

/** Empty every table this schema owns, keeping the shape. */
export async function emptyAll(): Promise<void> {
  assertTestDatabase();
  const targets = (await listTables()).filter((table) => !NOT_OURS.has(table));
  if (targets.length === 0) return;
  const list = targets.map((table) => `"public"."${table}"`).join(", ");
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
}

export async function listTables(): Promise<string[]> {
  const rows = await prisma.$queryRaw<Array<{ table_name: string }>>`
    SELECT table_name
      FROM information_schema.tables
     WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
     ORDER BY table_name
  `;
  return rows.map((row) => row.table_name);
}

export async function listColumns(table: string): Promise<string[]> {
  const rows = await prisma.$queryRaw<Array<{ column_name: string }>>`
    SELECT column_name
      FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = ${table}
     ORDER BY column_name
  `;
  return rows.map((row) => row.column_name);
}

/**
 * Every unique index on `table`: the columns it covers, and the key list
 * exactly as Postgres prints it.
 *
 * `pg_index`, not `schema.prisma`: an idempotency key that is org-scoped in the
 * model and globally unique in the database is exactly the bug this reads for,
 * and only the database can be asked which of the two shipped.
 *
 * `columns` is the plain-column view and reads `(expression)` for an index over
 * one — `lower(tool_key)` is a unique index on the tool key that no column list
 * would show. `keys` is the raw text, so a caller looking for constraints over a
 * column finds those too rather than being told, wrongly, that there are none.
 */
export async function listUniqueIndexes(
  table: string,
): Promise<Array<{ columns: string[]; keys: string }>> {
  const rows = await prisma.$queryRaw<Array<{ columns: string[]; definition: string }>>`
    SELECT array_agg(COALESCE(a.attname, '(expression)') ORDER BY k.ord) AS columns,
           MIN(pg_get_indexdef(i.oid)) AS definition
      FROM pg_class t
      JOIN pg_index ix ON ix.indrelid = t.oid
      JOIN pg_class i ON i.oid = ix.indexrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
      JOIN LATERAL unnest(ix.indkey) WITH ORDINALITY AS k(attnum, ord) ON TRUE
      LEFT JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
     WHERE n.nspname = 'public' AND t.relname = ${table} AND ix.indisunique
     GROUP BY i.relname
     ORDER BY i.relname
  `;
  return rows.map((row) => ({
    columns: row.columns,
    // The key list, between the first bracket of `... USING btree (...)` and
    // the last of the whole definition.
    keys: row.definition.slice(row.definition.indexOf("(") + 1, row.definition.lastIndexOf(")")),
  }));
}
