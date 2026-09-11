import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { POST as trpcRoute } from "@/app/api/trpc/[trpc]/route";
import { authCopy } from "@/lib/copy/auth";
import { approvalsCopy } from "@/lib/copy/approvals";
import { MACHINE_WORDS } from "@/lib/copy/plainWords";

/**
 * Approving, from outside the application.
 *
 * `tests/agents/handoff.test.ts` drives this procedure through
 * `createCaller`, which is the right shape for what it proves — but a caller
 * skips the HTTP adapter, and the adapter is where a real request meets
 * `createTRPCContext`. So the refusal a signed-out request gets is asserted
 * here, over the wire, through the route the deployment actually serves. If
 * `repProcedure` were ever swapped for `publicProcedure` on this router, this
 * is the case that fails; nothing in the caller-driven file would.
 */

/** Clerk's server module will not load outside an RSC. Same seam as `auth.test.ts`. */
vi.mock("@clerk/nextjs/server", () => ({
  auth: async () => ({ userId: null }),
  currentUser: async () => null,
}));

const ENDPOINT = "https://relay.test/api/trpc/approvals.approveStub";

/** The mutation as the client sends it: a POST whose body is the input. */
function approve(draftEventId: string): Promise<Response> {
  return trpcRoute(
    new Request(ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ draftEventId }),
    }) as never,
  );
}

describe("approving over HTTP with nobody signed in", () => {
  const saved = { ...process.env };

  beforeEach(() => {
    // The local bypass signs a request in from the environment alone, so a
    // suite that leaves `DEV_USER_EMAIL` set would make this case pass with a
    // session rather than without one.
    delete process.env.DEV_USER_EMAIL;
  });

  afterEach(() => {
    process.env = { ...saved };
  });

  it("@proof refuses the request, and does not reach the draft", async () => {
    const response = await approve("evt_someone_elses");

    // tRPC maps UNAUTHORIZED onto 401. The code is asserted as well as the
    // status, because the status alone would also be satisfied by a rate
    // limiter or a proxy.
    expect(response.status).toBe(401);
    // `json` is superjson's envelope, which the client unwraps and a raw
    // request has to reach through.
    const body = (await response.json()) as {
      error?: { json?: { message?: string; data?: { code?: string } } };
    };
    expect(body.error?.json?.data?.code).toBe("UNAUTHORIZED");
    expect(body.error?.json?.message).toBe(authCopy.signedOut);

    // And it is a refusal to act rather than a report on what exists: nothing
    // in the answer says whether that draft is real.
    expect(JSON.stringify(body)).not.toContain(approvalsCopy.notFound);
    expect(
      MACHINE_WORDS.test(body.error?.json?.message ?? ""),
      body.error?.json?.message,
    ).toBe(false);
  });
});
