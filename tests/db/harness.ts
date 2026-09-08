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
