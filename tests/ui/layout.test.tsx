/**
 * The root owns the theme and the type. This is the smoke that says so.
 *
 * `next/font/google` is a build-time transform — outside `next build` it has
 * no fonts to hash, so it is mocked here. What is being checked is not that
 * Google served a file, but that the layout stamps a theme and hangs the two
 * font variables where `tailwind.config.ts` expects to find them
 * (`--font-sans`, `--font-mono`). A rename on either side breaks this test
 * rather than silently falling back to system fonts on the live page.
 *
 * Rendered to static markup rather than into the DOM on purpose. The claim is
 * that the theme is stamped SERVER-side, so there is no flash of the wrong
 * palette before hydration — the server render is the thing under test. It
 * also avoids React hoisting `<html>` out of Testing Library's container,
 * which makes the assertions read as if they were about the test's own page.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { fonts } from "@/lib/tokens";

vi.mock("next/font/google", () => {
  const loader = (variable: string) => () => ({
    variable,
    className: `${variable}-class`,
    style: { fontFamily: variable },
  });
  return { Poppins: loader("--font-sans"), IBM_Plex_Mono: loader("--font-mono") };
});

const { default: RootLayout } = await import("@/app/layout");

function renderRoot(): { html: Element; body: Element } {
  const markup = renderToStaticMarkup(<RootLayout>{null}</RootLayout>);
  const parsed = new DOMParser().parseFromString(markup, "text/html");
  const { documentElement, body } = parsed;
  return { html: documentElement, body };
}

describe("root layout", () => {
  it("stamps the pilot default theme server-side, so there is no flash of the wrong palette", () => {
    expect(renderRoot().html.getAttribute("data-theme")).toBe("light");
  });

  it("declares the document language", () => {
    expect(renderRoot().html.getAttribute("lang")).toBe("en-GB");
  });

  it("hangs both font variables on the root, where the Tailwind theme reads them", () => {
    const { html } = renderRoot();
    expect(html.className).toContain("--font-sans");
    expect(html.className).toContain("--font-mono");
  });

  it("sets the body in the sans face", () => {
    expect(renderRoot().body.className).toContain("font-sans");
  });
});

/**
 * next/font statically analyses its own call, so the loader options cannot be
 * spread in from `src/lib/tokens.ts` — the build fails with "Unexpected
 * spread". The literals are therefore a second copy of signed values, and a
 * second copy drifts. This reads the source and holds it to the tokens.
 */
describe("font loading", () => {
  const source = readFileSync(path.join(process.cwd(), "src/app/layout.tsx"), "utf8");

  function loaderCall(loader: string): string {
    const match = new RegExp(String.raw`${loader}\(\{([\s\S]*?)\}\)`).exec(source);
    if (match === null) throw new Error(`No ${loader}({ ... }) call in src/app/layout.tsx.`);
    return match[1] as string;
  }

  const faces = [
    { loader: "Poppins", token: fonts.sans, variable: "--font-sans" },
    { loader: "IBM_Plex_Mono", token: fonts.mono, variable: "--font-mono" },
  ] as const;

  for (const { loader, token, variable } of faces) {
    describe(token.name, () => {
      it("loads exactly the signed weights", () => {
        const weights = /weight:\s*\[([^\]]*)\]/.exec(loaderCall(loader));
        expect(weights).not.toBeNull();
        const listed = (weights?.[1] ?? "")
          .split(",")
          .map((w) => w.trim().replace(/["']/g, ""))
          .filter((w) => w !== "");
        expect(listed).toEqual([...token.weights]);
      });

      it("declares the signed fallback stack", () => {
        const fallback = /fallback:\s*\[([^\]]*)\]/.exec(loaderCall(loader));
        expect(fallback).not.toBeNull();
        const listed = (fallback?.[1] ?? "")
          .split(",")
          .map((f) => f.trim().replace(/["']/g, ""))
          .filter((f) => f !== "");
        expect(listed).toEqual([...token.fallback]);
      });

      it("swaps rather than hiding the text while the face loads", () => {
        expect(loaderCall(loader)).toContain('display: "swap"');
      });

      it("exposes itself as the variable the Tailwind theme reads", () => {
        expect(loaderCall(loader)).toContain(`variable: "${variable}"`);
      });
    });
  }
});
