import { afterEach, describe, expect, it } from "vitest";

import { authCopy } from "@/lib/copy/auth";
import middleware from "@/middleware";

/**
 * The middleware's own branches, driven rather than read.
 *
 * `tests/api/middleware.test.ts` pins the public list and the matcher; this
 * drives the two paths that need no Clerk account — the local bypass, and the
 * deployment configured with neither Clerk nor a bypass, which must fail
 * closed rather than throw. The Clerk-configured branches are Clerk's own code
 * and are covered by the manual sign-in check the handoff records.
 */

/**
 * The live environment, as a writable record.
 *
 * A function and not a captured constant, and that matters: the `afterEach`
 * hooks below restore by replacing `process.env` wholesale, so a reference
 * taken once at module load points at an object nothing reads any more, and
 * every assignment through it silently does nothing. `@types/node` types
 * `NODE_ENV` read-only, which is exactly the variable these cases move, so the
 * cast is here rather than at each site.
 */
function environment(): Record<string, string | undefined> {
  return process.env as Record<string, string | undefined>;
}

const saved = { ...process.env };

afterEach(() => {
  process.env = { ...saved };
});

/**
 * One import for the whole file, and that is itself part of what is being
 * checked: the middleware reads the environment per request rather than once
 * at module load, so a deployment cannot end up serving a decision it made
 * before its configuration was in place.
 */
const call = middleware as unknown as (
  request: Request,
  event: unknown,
) => Promise<Response> | Response;

const request = (path: string) => new Request(`https://relay.test${path}`);

describe("the middleware without Clerk", () => {
  it("@proof lets every request through when the local bypass is on", async () => {
    environment().NODE_ENV = "development";
    environment().DEV_USER_EMAIL = "boss@example.test";

    for (const path of ["/", "/campaigns", "/api/health"]) {
      const response = await call(request(path), {});
      expect(response.status, path).toBe(200);
    }
  });

  it("@proof refuses every request when neither Clerk nor the bypass is configured", async () => {
    // Not a 500 from inside Clerk, and not a pass-through: an unauthenticated
    // door is the one answer a sign-in layer must never give when it cannot
    // work out who is knocking.
    environment().NODE_ENV = "production";
    delete environment().DEV_USER_EMAIL;
    delete environment().NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;

    for (const path of ["/", "/api/health", "/api/trpc/anything", "/sign-in"]) {
      const response = await call(request(path), {});
      expect(response.status, path).toBe(503);
    }
  });
});

describe("the copy the sign-in layer answers with", () => {
  it("names who can help, never what refused", () => {
    expect(authCopy.adminOnly).toContain("admin");
    expect(authCopy.needsWorkEmail).toContain("work email");
    for (const message of Object.values(authCopy)) {
      expect(message.toLowerCase(), message).not.toMatch(
        /clerk|procedure|middleware|forbidden|unauthorized|401|403/,
      );
    }
  });
});
