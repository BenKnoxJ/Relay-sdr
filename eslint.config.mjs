import path from "node:path";
import { fileURLToPath } from "node:url";

import { FlatCompat } from "@eslint/eslintrc";

const compat = new FlatCompat({
  baseDirectory: path.dirname(fileURLToPath(import.meta.url)),
});

// ── The app/worker boundary (master doc §18) ────────────────────────────────
// The worker runs as a plain Node process against Postgres alone: no Next, no
// Clerk, no App Router modules. `src/server/**` is off-limits too — it is the
// request-shaped layer and will grow Clerk imports, so a worker that reached
// through it would make this rule non-transitive and useless. Anything both
// sides need lives in `src/lib/**`, which is checked here as well.

const BOUNDARY_MESSAGE =
  "The worker and lib layers must run without Next or Clerk (master doc §18). Shared code belongs in src/lib; anything request-shaped belongs in src/app or src/server.";

// The relative escape, at any depth. An enumerated glob list stopped at
// whatever depth someone wrote down (`../app/*`, `../../app/*`), and the
// obvious widening — `**/app/**` — is too blunt: it also blocks
// `./server/tokens`, `@/lib/server/tokens` and `@trpc/server/adapters/fetch`,
// none of which cross anything. Anchoring on a leading run of `../` matches
// escapes and nothing else.
const RELATIVE_ESCAPE = String.raw`^\.\.\/(\.\.\/)*(app|server)(\/|$)`;

// The same set as an esquery attribute matcher, for the node types
// `no-restricted-imports` does not visit.
const BOUNDARY_SPECIFIER =
  String.raw`/^(next$|next\/|@clerk\/|@\/app\/|@\/server\/|\.\.\/(\.\.\/)*(app|server)(\/|$))/`;

// `no-restricted-imports` only listens to static import/export nodes, so
// `await import("@clerk/nextjs")` and `createRequire(import.meta.url)("next")`
// walk straight past it. The `env -i` worker smoke does not backstop that
// either: a lazy import on a path the smoke never executes is never loaded.
const BOUNDARY_DYNAMIC = [
  {
    selector: `ImportExpression[source.value=${BOUNDARY_SPECIFIER}]`,
    message: BOUNDARY_MESSAGE,
  },
  {
    selector: `CallExpression[callee.name="require"][arguments.0.value=${BOUNDARY_SPECIFIER}]`,
    message: BOUNDARY_MESSAGE,
  },
  {
    // `createRequire` is banned outright rather than pattern-matched on its
    // argument: `const req = createRequire(import.meta.url); req("next")`
    // splits the call from the specifier across two statements and no selector
    // can follow that. There is no legitimate use for it in these layers.
    selector: 'CallExpression[callee.name="createRequire"]',
    message: `createRequire is not available to the worker and lib layers: it reopens the boundary that no-restricted-imports closes. ${BOUNDARY_MESSAGE}`,
  },
];

// ── Nothing is deleted; states change (master doc §25, rule 1) ──────────────
// Matches the Prisma call *shape* — `<something>.<model>.delete(` — rather than
// a fixed list of client names, so an aliased client (`const client =
// ctx.prisma; client.person.delete()`) is caught too. Keying on
// `prisma`/`tx`/`db` by name left that as a one-line escape.
//
// Requiring the receiver to itself be a member expression is what keeps the
// standard library out: `map.delete(k)` and `new Map().delete(k)` have an
// identifier and a `new` expression in that position, not a member access. The
// `:not(...)` list covers the built-ins that ARE reached through a member
// access — `req.headers`, `url.searchParams`, `body.formData`, `cookies`.
//
// That list sits in the MODEL position of the Prisma shape, so anything on it
// is also a model name this rule would stop checking. It is therefore kept to
// four web-platform names and no further: a Prisma model called `headers`,
// `searchParams`, `cookies` or `formData` would be silently exempt, so do not
// name one that. Names that are plausible models — `cache`, `set`, `map`,
// `params` — are deliberately NOT exempt; a Map held on a field with one of
// those names is a false positive and takes a one-line `eslint-disable`, which
// is visible in review. False positives are cheap here and false negatives are
// not.
//
// This is a name-shape heuristic, not a type-aware rule. It does not see a
// destructured *delegate* (`const { person } = ctx.prisma; person.delete()`),
// because by then the receiver is a bare identifier and only types can say
// what it is. The upgrade path is typescript-eslint with type information,
// which cannot be fooled by naming at all; that is out of scope for Phase 1 —
// type-aware linting roughly triples lint time and there is no data model yet
// for it to reason about.
const DELETE_BAN = [
  {
    selector:
      'CallExpression > MemberExpression[property.name=/^(delete|deleteMany)$/][object.type="MemberExpression"]:not([object.property.name=/^(headers|searchParams|cookies|formData)$/])',
    message:
      "Relay does not delete rows; states change (master doc §25, rule 1). The only exception is src/lib/jobs/retention.ts, which writes an Event. If this is a Map or Set and not Prisma, disable this rule on the line and say why.",
  },
];

const WORKER_AND_LIB = ["src/worker/**/*.{ts,tsx}", "src/lib/**/*.{ts,tsx}"];
const RETENTION_JOB = "src/lib/jobs/retention.ts";

const config = [
  {
    ignores: [".next/**", "dist/**", "node_modules/**", "next-env.d.ts"],
  },

  ...compat.extends("next/core-web-vitals", "next/typescript"),

  // Flat config REPLACES a rule's options rather than merging them, so each
  // block below must carry every `no-restricted-syntax` selector that applies
  // to its files, and the blocks must stay in this order. Splitting the delete
  // ban and the boundary into two independent blocks would silently drop
  // whichever one lost the last-write.
  {
    files: ["src/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-syntax": ["error", ...DELETE_BAN],
    },
  },

  {
    files: WORKER_AND_LIB,
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["next", "next/*", "@clerk/*", "@/app/*", "@/server/*"],
              message: BOUNDARY_MESSAGE,
            },
            {
              regex: RELATIVE_ESCAPE,
              message: BOUNDARY_MESSAGE,
            },
          ],
        },
      ],
      "no-restricted-syntax": ["error", ...DELETE_BAN, ...BOUNDARY_DYNAMIC],
    },
  },

  // The retention job is the one carve-out from the delete ban, and it writes
  // an Event. It is still inside `src/lib`, so it keeps the boundary rules:
  // this block drops the delete ban only.
  {
    files: [RETENTION_JOB],
    rules: {
      "no-restricted-syntax": ["error", ...BOUNDARY_DYNAMIC],
    },
  },
];

export default config;
