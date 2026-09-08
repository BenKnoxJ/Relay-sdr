/**
 * The Relay worker.
 *
 * One of the three things the platform is (master doc §18): the app serves
 * screens and tRPC, the worker runs jobs and agent runs, and the two speak
 * only through Postgres. That is why nothing under `src/worker/**` may import
 * Next or Clerk — the lint boundary in eslint.config.mjs enforces it, and CI
 * runs this entry point with a scrubbed environment to prove it.
 *
 * Today it opens the database, proves it is reachable, and exits. The job
 * claim/lease loop lands in its own task.
 */
import type { PrismaClient } from "@prisma/client";

import { env } from "@/lib/env";

// Held here so the failure handler can close a connection that main() opened.
let prisma: PrismaClient | undefined;

async function main(): Promise<void> {
  const once = process.argv.slice(2).includes("--once");

  // What keeps a misconfigured worker inside the JSON error contract below is
  // that this import is dynamic: `src/lib/db.ts` reads the environment as it
  // loads, and only inside `main()` is that throw caught by `main().catch`. A
  // static top-level import would evaluate before the handler is registered
  // and die on a raw stack trace instead — the regression this line exists to
  // prevent, and `tests/lib/worker.test.ts` proves it stays dynamic. The
  // specifier is a literal, which is what the boundary lint requires.
  //
  // Calling `env()` first is not what makes that work; it is here to put
  // INTEGRATIONS in scope for the "started" line below.
  const { INTEGRATIONS } = env();
  ({ prisma } = await import("@/lib/db"));

  await prisma.$queryRaw`SELECT 1`;
  console.log(
    JSON.stringify({
      at: new Date().toISOString(),
      component: "worker",
      event: "started",
      mode: once ? "once" : "loop",
      integrations: INTEGRATIONS,
      db: "ok",
    }),
  );

  if (!once) {
    // The polling loop lands with the jobs spine. Until then a bare
    // `npm run worker` must not pretend to be a running service.
    console.log(
      JSON.stringify({
        at: new Date().toISOString(),
        component: "worker",
        event: "no-loop-yet",
        detail: "The job loop lands with the jobs spine. Use --once for now.",
      }),
    );
  }

  await prisma.$disconnect();
}

main().catch(async (error: unknown) => {
  console.error(
    JSON.stringify({
      at: new Date().toISOString(),
      component: "worker",
      event: "failed",
      error: error instanceof Error ? error.message : String(error),
    }),
  );
  await prisma?.$disconnect().catch(() => undefined);
  process.exit(1);
});
