import { approvalsRouter } from "@/server/api/routers/approvals";
import { campaignsRouter } from "@/server/api/routers/campaigns";
import { connectionsRouter } from "@/server/api/routers/connections";
import { meRouter } from "@/server/api/routers/me";
import { runsRouter } from "@/server/api/routers/runs";
import { createTRPCRouter } from "@/server/api/trpc";

/**
 * The primary router. Feature routers are added here as each task lands one.
 */
export const appRouter = createTRPCRouter({
  me: meRouter,
  campaigns: campaignsRouter,
  approvals: approvalsRouter,
  connections: connectionsRouter,
  runs: runsRouter,
});

export type AppRouter = typeof appRouter;
