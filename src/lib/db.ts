import { PrismaClient } from "@prisma/client";

import { env } from "@/lib/env";

// The only `new PrismaClient()` in the codebase. Next's dev server re-evaluates
// modules on every edit, so the client is cached on globalThis outside
// production to stop the connection pool growing without bound.
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

// Reading it here rather than at each use is also the boot check: a process
// that opens the database has validated its whole environment first.
const { NODE_ENV } = env();

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: NODE_ENV === "development" ? ["error", "warn"] : ["error"],
  });

if (NODE_ENV !== "production") globalForPrisma.prisma = prisma;
