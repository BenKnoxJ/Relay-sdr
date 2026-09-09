import { campaignsRouter } from "@/server/api/routers/campaigns";
import { connectionsRouter } from "@/server/api/routers/connections";
import { meRouter } from "@/server/api/routers/me";
import { createTRPCRouter } from "@/server/api/trpc";

/**
 * The primary router. Feature routers are added here as each task lands one.
 */
export const appRouter = createTRPCRouter({
  me: meRouter,
  campaigns: campaignsRouter,
  connections: connectionsRouter,
});

export type AppRouter = typeof appRouter;
