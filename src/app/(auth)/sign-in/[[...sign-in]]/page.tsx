import { SignIn } from "@clerk/nextjs";

import { authCopy } from "@/lib/copy/auth";
import { clerkPublishableKey } from "@/lib/env";

/**
 * The sign-in screen: Clerk's component, on the page, and nothing else.
 *
 * Unstyled on purpose. Task 9a owns the tokens and the shell, and a set of
 * one-off colours here would be the first thing it had to delete. The two
 * strings come from the copy file so the rep-words sweep covers them from the
 * moment this lands.
 *
 * The optional catch-all segment is Clerk's requirement, not a choice: the
 * component routes its own sub-steps (factor two, reset, SSO callback) under
 * this path.
 *
 * `<SignIn />` is rendered only when there is a provider above it to render
 * into. Without a publishable key `src/app/layout.tsx` mounts no
 * `ClerkProvider`, and the component throws — which turned this page into a
 * 500 on the two configurations that are meant to work without Clerk: a
 * developer on the `DEV_USER_EMAIL` bypass, and CI. Both are already signed
 * in, or have nothing to sign in to, so the page says so instead.
 */
export default function SignInPage() {
  return (
    <main>
      <h1>{authCopy.signInTitle}</h1>
      <p>{authCopy.signInSubtitle}</p>
      {clerkPublishableKey() === null ? <p>{authCopy.signInUnavailable}</p> : <SignIn />}
    </main>
  );
}
