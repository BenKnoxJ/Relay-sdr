import { ClerkProvider } from "@clerk/nextjs";
import type { Metadata } from "next";

import { shellCopy } from "@/lib/copy/shell";
import { clerkPublishableKey } from "@/lib/env";

import "./globals.css";

export const metadata: Metadata = {
  title: shellCopy.appName,
};

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
    <html lang="en">
      <body>{children}</body>
    </html>
  );

  const publishableKey = clerkPublishableKey();

  return publishableKey === null ? (
    body
  ) : (
    <ClerkProvider publishableKey={publishableKey}>{body}</ClerkProvider>
  );
}
