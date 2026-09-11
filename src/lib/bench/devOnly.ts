import { env } from "@/lib/env";

/**
 * Whether the bench exists in this process.
 *
 * Development only, and the check is an allowlist rather than a "not
 * production" — the same shape `DEV_USER_EMAIL` and `RELAY_AGENT_STUB_MODEL`
 * take in `src/lib/env.ts`, and for the same reason: `NODE_ENV` is unset in an
 * ordinary shell, and a rule written as "unless production" is off in exactly
 * the environment nobody thought about.
 *
 * `test` is not on the list. The bench is a screen a person looks at, and the
 * suite proves the guard by proving the pages refuse — which they cannot do if
 * the environment they run in is the one that turns them on.
 *
 * This is the second of two gates and the weaker one. The first is that the
 * pages are named `page.dev.tsx` and `pageExtensions` in `next.config.mjs`
 * only counts that suffix in development, so a production build has no bench
 * route to serve at all. This one covers the case that gate cannot: a build run
 * with `NODE_ENV=development` and then served.
 *
 * The environment is a parameter with `env()` as its default, the same shape
 * `credentialKind` takes: `env()` memoises, so a test that reached in and
 * changed `process.env` would be asserting against whatever the first caller
 * in the file happened to see.
 */
export function benchEnabled(source: Pick<ReturnType<typeof env>, "NODE_ENV"> = env()): boolean {
  return source.NODE_ENV === "development";
}
