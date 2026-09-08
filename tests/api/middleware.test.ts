import { describe, expect, it } from "vitest";

import { PUBLIC_API_ROUTES, config } from "@/middleware";

/**
 * The public surface, pinned.
 *
 * Sign-in is default-deny: everything is protected unless it is on a list, and
 * the value of that arrangement is entirely in the list staying short. A route
 * added to it should be a decision somebody made, which is what a failing test
 * makes it.
 */
describe("the middleware's public surface", () => {
  it("@proof exposes exactly two API routes without a session", () => {
    // `/api/trpc` is here because tRPC's own procedure builders are the gate
    // and give a client an answer it can read; everything else is protected.
    expect(PUBLIC_API_ROUTES).toEqual(["/api/health", "/api/trpc(.*)"]);
  });

  it("@proof runs on the API and tRPC paths, which the asset pattern would skip", () => {
    // The first pattern excludes anything with a file extension, and the
    // second is what puts `/api/**` and `/trpc/**` back. Without it the whole
    // API is unprotected and nothing else in the suite would notice.
    expect(config.matcher).toContain("/(api|trpc)(.*)");
    expect(config.matcher).toHaveLength(2);
  });

  it("@proof matches an ordinary page, and skips Next's own assets", () => {
    const [pages] = config.matcher;
    expect(pages).toBeDefined();
    const matches = (pathname: string) => new RegExp(`^${pages}$`).test(pathname);

    for (const protectedPath of ["/", "/campaigns", "/settings/accounts"]) {
      expect(matches(protectedPath), protectedPath).toBe(true);
    }
    for (const skipped of ["/_next/static/chunk.js", "/logo.svg", "/styles.css", "/favicon.ico"]) {
      expect(matches(skipped), skipped).toBe(false);
    }
  });
});
