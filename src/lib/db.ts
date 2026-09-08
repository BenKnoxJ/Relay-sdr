import { PrismaClient } from "@prisma/client";

import { env } from "@/lib/env";

// The only `new PrismaClient()` in the codebase. Next's dev server re-evaluates
// modules on every edit, so the client is cached on globalThis outside
// production to stop the connection pool growing without bound.
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

// Reading it here rather than at each use is also the boot check: a process
// that opens the database has validated its whole environment first.
const { NODE_ENV, DATABASE_URL } = env();

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    // The client connects on the validated value, not on `schema.prisma`'s own
    // `env("DATABASE_URL")` read. Otherwise the module that exists to be the
    // one source of configuration is a check running alongside the real read,
    // and a string this file rejected could still be the one Prisma dials.
    // `directUrl` stays on the schema: it is the migration CLI's, not the
    // client's, and the CLI runs without this module.
    datasourceUrl: DATABASE_URL,
    log: NODE_ENV === "development" ? ["error", "warn"] : ["error"],
  });

if (NODE_ENV !== "production") globalForPrisma.prisma = prisma;
