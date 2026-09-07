import path from "node:path";
import { fileURLToPath } from "node:url";

import { FlatCompat } from "@eslint/eslintrc";

const compat = new FlatCompat({
  baseDirectory: path.dirname(fileURLToPath(import.meta.url)),
});

const config = [
  {
    ignores: [".next/**", "dist/**", "node_modules/**", "next-env.d.ts"],
  },

  ...compat.extends("next/core-web-vitals", "next/typescript"),

  // ── The app/worker boundary (master doc §18) ──────────────────────────────
  // The worker runs as a plain Node process against Postgres alone: no Next,
  // no Clerk, no App Router modules. `src/server/**` is off-limits too — it is
  // the request-shaped layer and will grow Clerk imports, so a worker that
  // reached through it would make this rule non-transitive and useless.
  // Anything both sides need lives in `src/lib/**`, which is checked here.
  {
    files: ["src/worker/**/*.ts", "src/lib/**/*.ts"],
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
                "@/app/*",
                "@/server/*",
                "../app/*",
                "../server/*",
                "../../app/*",
                "../../server/*",
              ],
              message:
                "The worker and lib layers must run without Next or Clerk (master doc §18). Shared code belongs in src/lib; anything request-shaped belongs in src/app or src/server.",
            },
          ],
        },
      ],
    },
  },

  // ── Nothing is deleted; states change (master doc §25, rule 1) ────────────
  // Scoped to Prisma client calls (`prisma.person.delete`, `tx.person.delete`,
  // `ctx.prisma.person.deleteMany`). A blanket ban on `.delete(` would also
  // catch Map, Headers and URLSearchParams, which have nothing to do with the
  // rule. The retention job is the one carve-out, and it writes an Event.
  {
    files: ["src/**/*.ts", "src/**/*.tsx"],
    ignores: ["src/lib/jobs/retention.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector:
            'CallExpression > MemberExpression[property.name=/^(delete|deleteMany)$/][object.object.name=/^(prisma|tx|trx|db)$/]',
          message:
            "Relay does not delete rows; states change (master doc §25, rule 1). The only exception is src/lib/jobs/retention.ts, which writes an Event.",
        },
        {
          selector:
            'CallExpression > MemberExpression[property.name=/^(delete|deleteMany)$/][object.object.property.name=/^(prisma|tx|trx|db)$/]',
          message:
            "Relay does not delete rows; states change (master doc §25, rule 1). The only exception is src/lib/jobs/retention.ts, which writes an Event.",
        },
      ],
    },
  },
];

export default config;
