import { approvalsRouter } from "@/server/api/routers/approvals";
import { campaignsRouter } from "@/server/api/routers/campaigns";
import { meRouter } from "@/server/api/routers/me";
import { createTRPCRouter } from "@/server/api/trpc";

/**
 * The primary router. Feature routers are added here as each task lands one.
 */
export const appRouter = createTRPCRouter({
  me: meRouter,
  campaigns: campaignsRouter,
  approvals: approvalsRouter,
});

export type AppRouter = typeof appRouter;
