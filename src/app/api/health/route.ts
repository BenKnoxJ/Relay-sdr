import { NextResponse } from "next/server";

import { prisma } from "@/lib/db";

// The database is checked per request, so this route must never be prerendered.
export const dynamic = "force-dynamic";

/**
 * The one runtime proof the scaffold ships: can the app reach its database?
 * `down` is a 503 so an uptime check fails on it without parsing the body.
 */
export async function GET() {
  try {
    // A liveness probe, not a write: `SELECT 1` reads nothing and changes
    // nothing, so it has no state change for `mutate` to record an Event
    // against.
    // eslint-disable-next-line no-restricted-syntax
    await prisma.$queryRaw`SELECT 1`;
    return NextResponse.json({ db: "ok" });
  } catch (error: unknown) {
    // Structured, like the worker's: an outage that leaves no diagnostics is
    // the one thing a health check must not do.
    console.error(
      JSON.stringify({
        at: new Date().toISOString(),
        component: "health",
        event: "db-unreachable",
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    return NextResponse.json({ db: "down" }, { status: 503 });
  }
}
