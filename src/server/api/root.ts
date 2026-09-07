import { createTRPCRouter } from "@/server/api/trpc";

/**
 * The primary router. Feature routers are added here as each task lands one.
 */
export const appRouter = createTRPCRouter({});

export type AppRouter = typeof appRouter;
