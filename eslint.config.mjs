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

// The relative escape, at any depth and in any spelling. An enumerated glob
// list stopped at whatever depth someone wrote down (`../app/*`,
// `../../app/*`), and the obvious widening — `**/app/**` — is too blunt: it
// also blocks `./server/tokens`, `@/lib/server/tokens` and
// `@trpc/server/adapters/fetch`, none of which cross anything.
//
// So: a relative specifier (the lookahead) that contains a `..` segment and
// reaches an `app` or `server` segment after it. That covers `../app/x`,
// `../../../app/x`, `./../app/x` and `../lib/../app/x` alike, and leaves
// `./server/x` and `../db` alone. One deliberate false positive remains: if a
// `src/lib/server/` directory is ever added, a sibling reaching it as
// `../server/x` is indistinguishable from an escape — import it as
// `@/lib/server/x`.
const RELATIVE_ESCAPE = String.raw`^(?=\.)(?:[^/]+\/)*\.\.\/(?:[^/]+\/)*(app|server)(\/|$)`;

// The same set as an esquery attribute matcher, for the node types
// `no-restricted-imports` does not visit.
const BOUNDARY_SPECIFIER = String.raw`/^(next$|next\/|@clerk\/|@\/(app|server)($|\/)|(?=\.)([^/]+\/)*\.\.\/([^/]+\/)*(app|server)(\/|$))/`;

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
    // A specifier that is not a plain string literal cannot be checked at all:
    // import(`next/headers`) and `import(someVariable)` both walk past the
    // rule above. Requiring a literal is what makes that check total, and
    // these layers have no need for a computed module path.
    selector: 'ImportExpression:not([source.type="Literal"])',
    message: `A dynamic import in the worker and lib layers must take a plain string literal, so the boundary check can read it. ${BOUNDARY_MESSAGE}`,
  },
  {
    selector: `CallExpression[callee.name="require"][arguments.0.value=${BOUNDARY_SPECIFIER}]`,
    message: BOUNDARY_MESSAGE,
  },
  {
    // `createRequire` is stopped at the call in both spellings — bare and
    // through a namespace (`mod.createRequire(...)`) — because matching its
    // argument is not enough: `const req = createRequire(url); req("next")`
    // splits the call from the specifier across two statements. The import of
    // `node:module` is banned as well (see the group below), which is the part
    // that actually closes it: there is no other route to `createRequire`.
    selector:
      'CallExpression[callee.name="createRequire"], CallExpression[callee.property.name="createRequire"]',
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
// not, which is also why the selector matches the member access itself rather
// than only a call: `queueMicrotask(p.person.delete)` hands the same capability
// to someone else and is worth a look.
//
// This is a name-shape heuristic, not a type-aware rule. It does not see a
// destructured *delegate* (`const { person } = ctx.prisma; person.delete()`),
// because by then the receiver is a bare identifier and only types can say
// what it is. The upgrade path is typescript-eslint with type information,
// which cannot be fooled by naming at all; that is out of scope for Phase 1 —
// type-aware linting roughly triples lint time and there is no data model yet
// for it to reason about.
const DELETE_MESSAGE =
  "Relay does not delete rows; states change (master doc §25, rule 1). The only exception is src/lib/jobs/retention.ts, which writes an Event. If this is a Map or Set and not Prisma, disable this rule on the line and say why.";

const BUILTIN_RECEIVERS = "^(headers|searchParams|cookies|formData)$";

const DELETE_BAN = [
  {
    selector: `MemberExpression[computed=false][property.name=/^(delete|deleteMany)$/][object.type="MemberExpression"]:not([object.property.name=/${BUILTIN_RECEIVERS}/])`,
    message: DELETE_MESSAGE,
  },
  {
    // `p.person["delete"]({})` is the same call with the property in a string.
    selector: `MemberExpression[computed=true][property.value=/^(delete|deleteMany)$/][object.type="MemberExpression"]:not([object.property.name=/${BUILTIN_RECEIVERS}/])`,
    message: DELETE_MESSAGE,
  },
];

// ── One write path (master doc §25, rule 4) ─────────────────────────────────
// "A state change and its Event commit in one transaction" is only true if
// there is one place that can write. That place is `src/lib/repo/**`, whose
// `mutate()` opens the transaction and inserts the Event; the queue
// (`src/lib/jobs/queue.ts`) is the one other writer, because enqueueing a job
// is not a domain event.
//
// The selector is the delete ban's shape, for the same reasons and with the
// same limits: it matches `<something>.<model>.create(` rather than a list of
// client names, so an aliased client is caught; it does not see a destructured
// delegate, which needs type information.
//
// Two differences from the delete ban are worth knowing before widening either:
//
//   * There is no built-in-receiver allowlist. `delete` needed one because
//     `req.headers.delete()` is everyday code. These verbs have no equivalent
//     — `hash.update()` and `cipher.update()` are reached through an
//     identifier, not a member access, so the `object.type` requirement
//     already excludes them.
//   * It costs more false positives. `state.form.update(v)` matches, and the
//     answer is a one-line `eslint-disable` with a reason, which is visible in
//     review. A missed write is a state change with no Event, which is not.
//
// The ban covers `src/**`, which is where the application lives — the same
// reach the delete ban has. `prisma/seed.ts`, `scripts/**` and `tests/**` are
// outside it on purpose: seeding and test fixtures exist to put rows in the
// database directly, and an Event per fixture row would be noise. That is also
// why `tests/db/harness.ts` can issue raw SQL.
//
// Raw SQL is banned outright outside the write path, in all four spellings. A
// `$executeRawUnsafe` reaching past this rule is the whole rule gone, and
// `$queryRaw` writes too — `WITH x AS (UPDATE …) SELECT` is a query as far as
// the name goes. Reads that genuinely need raw SQL belong in the repository
// layer with the writes.
const WRITE_MESSAGE =
  "Every write goes through src/lib/repo (mutate opens the transaction and records the Event — master doc §25, rule 4); the queue in src/lib/jobs/queue.ts is the only other writer. If this is not Prisma, disable this rule on the line and say why.";

const WRITE_VERBS = "^(create|createMany|createManyAndReturn|update|updateMany|updateManyAndReturn|upsert)$";
const RAW_VERBS = String.raw`^\$(executeRaw|executeRawUnsafe|queryRaw|queryRawUnsafe)$`;

const WRITE_BAN = [
  {
    selector: `MemberExpression[computed=false][property.name=/${WRITE_VERBS}/][object.type="MemberExpression"]`,
    message: WRITE_MESSAGE,
  },
  {
    selector: `MemberExpression[computed=true][property.value=/${WRITE_VERBS}/][object.type="MemberExpression"]`,
    message: WRITE_MESSAGE,
  },
  {
    // `prisma.$executeRawUnsafe(...)` — one level, not two, so it needs its own
    // selector. `$`-prefixed names are Prisma's alone, so no receiver check is
    // needed and none is made.
    selector: `MemberExpression[computed=false][property.name=/${RAW_VERBS}/]`,
    message: WRITE_MESSAGE,
  },
  {
    // And its computed twin, `prisma["$executeRawUnsafe"](...)`. Every other
    // selector here ships one; without it this is the cheapest escape in the
    // file.
    selector: `MemberExpression[computed=true][property.value=/${RAW_VERBS}/]`,
    message: WRITE_MESSAGE,
  },
];

// ── The tenant is the session's, never the request's (master doc §26) ───────
// `mutate` trusts the `orgId` it is handed — its own comment says so — so the
// question of whether one tenant can write into another comes down to where
// callers get that value. There is exactly one right answer: `ctx.orgId`, put
// there by `repProcedure` after the session was resolved. A body field named
// `orgId` is a tenant the caller picked for themselves.
//
// Sentinel deferred this on PR #3 for want of a caller to check. Task 8 is the
// first one, so the rule lands with it.
//
// `orgId` is banned outright: there is no procedure that should take one from
// the wire. `userId` is not, because an admin filtering by rep legitimately
// passes one (master doc §8, "admin is additive") — it is banned only in the
// `actor` of an Event, which must be whoever is actually signed in.
//
// It matches the value's shape, so it sees `input.orgId` and `input.x.orgId`
// and does not see `const { orgId } = input`, which needs type information —
// the same limit, and the same upgrade path, as the delete and write bans. A
// legitimate `orgId` sourced from a variable called `input` (there is none
// today) takes a one-line `eslint-disable` with a reason.
const TENANT_MESSAGE =
  "The org comes from the session (ctx.orgId, set by repProcedure), never from request input: an orgId off the wire is a tenant the caller chose for themselves (master doc §26).";

const TENANT_BAN = [
  {
    selector: 'Property[key.name="orgId"][value.object.name="input"]',
    message: TENANT_MESSAGE,
  },
  {
    selector: 'Property[key.name="orgId"][value.object.object.name="input"]',
    message: TENANT_MESSAGE,
  },
  {
    // The Event's actor is who did it. Taken from input, every Event in the
    // audit trail names whoever the caller nominated.
    selector:
      'Property[key.name="actor"] Property[key.name="userId"][value.object.name="input"], Property[key.name="actor"] Property[key.name="userId"][value.object.object.name="input"]',
    message:
      "The actor of an Event is the signed-in user (ctx.userId, set by repProcedure), never a value from request input.",
  },
];

const WORKER_AND_LIB = ["src/worker/**/*.{ts,tsx}", "src/lib/**/*.{ts,tsx}"];
const RETENTION_JOB = "src/lib/jobs/retention.ts";
const WRITE_PATH = ["src/lib/repo/**/*.{ts,tsx}", "src/lib/jobs/queue.ts"];

const config = [
  {
    ignores: [".next/**", "dist/**", "node_modules/**", "next-env.d.ts"],
  },

  ...compat.extends("next/core-web-vitals", "next/typescript"),

  // Flat config REPLACES a rule's options rather than merging them, so each
  // block below must carry every `no-restricted-syntax` selector that applies
  // to its files, and the blocks must stay in this order. Splitting the delete
  // ban and the boundary into two independent blocks would silently drop
  // whichever one lost the last write.
  {
    files: ["src/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-syntax": ["error", ...DELETE_BAN, ...WRITE_BAN, ...TENANT_BAN],
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
              group: [
                "next",
                "next/*",
                "@clerk/*",
                // Bare and sub-path both: a barrel at `src/server/index.ts`
                // would otherwise be reachable as plain `@/server`.
                "@/app",
                "@/app/*",
                "@/server",
                "@/server/*",
                // The only route to `createRequire`, which reopens everything
                // above. Banned at the import, not just at the call site.
                "node:module",
                "module",
              ],
              message: BOUNDARY_MESSAGE,
            },
            {
              regex: RELATIVE_ESCAPE,
              message: BOUNDARY_MESSAGE,
            },
          ],
        },
      ],
      "no-restricted-syntax": ["error", ...DELETE_BAN, ...WRITE_BAN, ...TENANT_BAN, ...BOUNDARY_DYNAMIC],
    },
  },

  // The retention job is the one carve-out from the delete ban, and it writes
  // an Event. It is still inside `src/lib`, so it keeps the boundary rules:
  // this block drops the delete ban only.
  {
    files: [RETENTION_JOB],
    rules: {
      "no-restricted-syntax": ["error", ...WRITE_BAN, ...TENANT_BAN, ...BOUNDARY_DYNAMIC],
    },
  },

  // The write path is the carve-out from the write ban, and only from that
  // one: nothing is deleted here either, and it is inside `src/lib`, so the
  // boundary still applies. This block is last because these files also match
  // `src/**` and WORKER_AND_LIB, and flat config gives the last write.
  {
    files: WRITE_PATH,
    rules: {
      "no-restricted-syntax": ["error", ...DELETE_BAN, ...TENANT_BAN, ...BOUNDARY_DYNAMIC],
    },
  },
];

export default config;
