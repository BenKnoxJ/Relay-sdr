import { ClerkProvider } from "@clerk/nextjs";
import type { Metadata } from "next";
import { IBM_Plex_Mono, Poppins } from "next/font/google";

import { shellCopy } from "@/lib/copy/shell";
import { clerkPublishableKey } from "@/lib/env";

import "./globals.css";

export const metadata: Metadata = {
  title: shellCopy.appName,
};

/**
 * Poppins throughout, counts in IBM Plex Mono (signed design system §2).
 *
 * `next/font` downloads both at build time and serves them from our own
 * origin, so there is no request to Google at runtime and no third party
 * learning who reads a Relay page. `display: "swap"` is what the signed file
 * asks for: text is readable in the fallback immediately and reflows once,
 * rather than sitting invisible.
 *
 * The weights are the signed ones and no more — each extra weight is another
 * file on the critical path.
 *
 * These options are written out as literals rather than read from
 * `src/lib/tokens.ts`, and have to be: next/font is a compile-time transform
 * that statically analyses this call, and it rejects a spread or a variable
 * outright ("Unexpected spread"). `tests/ui/layout.test.tsx` reads this source
 * and holds the literals to the token values, so the single source survives
 * the constraint.
 */
const sans = Poppins({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  display: "swap",
  variable: "--font-sans",
  fallback: ["system-ui", "sans-serif"],
});

const mono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  display: "swap",
  variable: "--font-mono",
  fallback: ["ui-monospace", "monospace"],
});

/**
 * The provider is conditional, and has to be: `ClerkProvider` throws without a
 * publishable key, and the two ways Relay runs without one are both
 * first-class, not misconfigurations. A developer on the `DEV_USER_EMAIL`
 * bypass has no key, and neither does CI, which builds and runs the whole
 * suite with no Clerk account behind it (there is not one yet; brief D1).
 *
 * The key is passed as a prop rather than left for Clerk to read out of the
 * environment itself, so that the one file allowed to touch `process.env` is
 * still the one file that does.
 */
export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const body = (
    /**
     * `data-theme` is the single theme switch: the generated stylesheet keys
     * both palettes off it, and Tailwind's `dark:` variant is bound to it.
     * Light is the pilot default (signed file §5, rule 5) and is stamped
     * server-side, so there is no flash of the wrong palette. Phase 1 ships no
     * toggle; when one arrives it moves this attribute and nothing else.
     *
     * `suppressHydrationWarning` is here for that future toggle — a client
     * that restores a stored theme before React hydrates would otherwise trip
     * an attribute mismatch on `<html>`.
     */
    <html
      lang="en-GB"
      data-theme="light"
      suppressHydrationWarning
      className={`${sans.variable} ${mono.variable}`}
    >
      <body className="font-sans antialiased">{children}</body>
    </html>
  );

  const publishableKey = clerkPublishableKey();

  return publishableKey === null ? (
    body
  ) : (
    <ClerkProvider publishableKey={publishableKey}>{body}</ClerkProvider>
  );
}
