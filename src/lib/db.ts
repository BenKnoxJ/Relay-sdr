import { PrismaClient } from "@prisma/client";

// The only `new PrismaClient()` in the codebase. Next's dev server re-evaluates
// modules on every edit, so the client is cached on globalThis outside
// production to stop the connection pool growing without bound.
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["error", "warn"] : ["error"],
  });

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
