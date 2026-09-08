import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

/**
 * `scripts/db-deploy.sh` — the named owner of "migrations applied to Neon".
 *
 * The script exists for one reason the bare `prisma migrate deploy` cannot
 * serve: it refuses to run a *production* deploy against a local database.
 * The mistake it is built to catch is a shell that still has the Docker
 * connection string exported from an afternoon of local work, and an operator
 * who then runs the production migration step in it — which applies (or worse,
 * finds already-applied) migrations against `relay_test` while Neon stays
 * untouched and the deploy is reported green.
 *
 * Both connection strings are checked, not just `DATABASE_URL`. Prisma's
 * migration engine connects over `directUrl`, so a run with a Neon
 * `DATABASE_URL` and a leftover local `DIRECT_URL` is exactly the accident
 * above, and a guard that looked only at the pooled URL would wave it through.
 * (The brief names `DATABASE_URL`; this is wider, deliberately — see the PR.)
 */

const run = promisify(execFile);
const script = path.resolve(import.meta.dirname, "..", "..", "scripts", "db-deploy.sh");

const NEON = "postgresql://relay:pw@ep-example-123456.eu-west-2.aws.neon.tech/relay?sslmode=require";
const LOCAL = "postgresql://relay:relay@127.0.0.1:5435/relay";

/**
 * `--dry-run` runs every check and stops before Prisma. Without it the only
 * testable outcomes would be refusals, and a script that refused everything
 * would pass such a suite completely.
 */
async function deploy(
  env: Record<string, string>,
  extraArgs: string[] = [],
  options: { dryRunLast?: boolean } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const argv =
    options.dryRunLast === true ? [...extraArgs, "--dry-run"] : ["--dry-run", ...extraArgs];
  // Typed as a plain string map before the cast, for the same reason
  // tests/worker/harness.ts does it: Next augments NodeJS.ProcessEnv to
  // require NODE_ENV, and several of these cases are precisely about which
  // variables are and are not present.
  const childEnv: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    ...env,
  };

  try {
    const { stdout, stderr } = await run("bash", [script, ...argv], {
      env: childEnv as NodeJS.ProcessEnv,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failure.code ?? -1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
  }
}

/**
 * The same script, run from a throwaway root — `scripts/db-deploy.sh` resolves
 * its repository as `dirname $0/..`, so a copy two levels down inside a temp
 * directory gets that directory as its root and the `.env` written there.
 * Never the real repository root: a test that writes a `.env` next to
 * `package.json` would overwrite a developer's own.
 */
async function deployFromCopy(
  env: Record<string, string>,
  dotenv?: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "relay-db-deploy-"));
  await mkdir(path.join(root, "scripts"));
  await copyFile(script, path.join(root, "scripts", "db-deploy.sh"));
  if (dotenv !== undefined) await writeFile(path.join(root, ".env"), dotenv);

  const childEnv: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    ...env,
  };
  try {
    const { stdout, stderr } = await run("bash", [path.join(root, "scripts", "db-deploy.sh"), "--dry-run"], {
      env: childEnv as NodeJS.ProcessEnv,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failure.code ?? -1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
  }
}

describe("scripts/db-deploy.sh", () => {
  it("refuses a production deploy pointed at a local DATABASE_URL", async () => {
    const result = await deploy({ NODE_ENV: "production", DATABASE_URL: LOCAL, DIRECT_URL: NEON });

    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/DATABASE_URL/);
    expect(result.stderr).toMatch(/127\.0\.0\.1/);
  });

  it("refuses a production deploy pointed at a local DIRECT_URL", async () => {
    // The one the migration engine actually connects over.
    const result = await deploy({ NODE_ENV: "production", DATABASE_URL: NEON, DIRECT_URL: LOCAL });

    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/DIRECT_URL/);
  });

  it.each(["localhost", "::1", "0.0.0.0"])(
    "refuses a production deploy pointed at %s, not just 127.0.0.1",
    async (host) => {
      const url =
        host === "::1"
          ? "postgresql://relay:relay@[::1]:5435/relay"
          : `postgresql://relay:relay@${host}:5435/relay`;
      const result = await deploy({ NODE_ENV: "production", DATABASE_URL: url, DIRECT_URL: url });

      expect(result.code).not.toBe(0);
      expect(result.stderr).toMatch(/DATABASE_URL/);
    },
  );

  it("refuses a local deploy when NODE_ENV is unset, because silence is production", async () => {
    // The case a `NODE_ENV = "production"` guard would have missed entirely,
    // and the one the stale-shell accident actually arrives in: NODE_ENV is
    // not set in an ordinary shell. Same allowlist as src/lib/env.ts.
    //
    // From a copy: this is the one case that deliberately leaves NODE_ENV
    // unset, so run against the real repository root it would read whatever
    // .env the developer was told to create and pass on their machine only.
    const result = await deployFromCopy({ DATABASE_URL: LOCAL, DIRECT_URL: LOCAL });

    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/unset/);
  });

  it.each(["development", "test"])(
    "allows a local deploy when NODE_ENV is explicitly %s",
    async (nodeEnv) => {
      const result = await deploy({ NODE_ENV: nodeEnv, DATABASE_URL: LOCAL, DIRECT_URL: LOCAL });

      expect(result.stderr).toBe("");
      expect(result.code).toBe(0);
      expect(result.stdout).toMatch(/prisma migrate deploy/);
    },
  );

  it("passes unrecognised flags through to Prisma instead of swallowing them", async () => {
    // `--dry-run` is this script's; everything else belongs to `migrate
    // deploy`. Dropping the rest would make `db:deploy -- --schema=…` silently
    // do something other than it says.
    const result = await deploy({ NODE_ENV: "development", DATABASE_URL: LOCAL, DIRECT_URL: LOCAL }, [
      "--schema=prisma/schema.prisma",
    ]);

    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/--schema=prisma\/schema\.prisma/);
  });

  it("finds --dry-run wherever it appears in the arguments", async () => {
    const result = await deploy(
      { NODE_ENV: "production", DATABASE_URL: LOCAL, DIRECT_URL: LOCAL },
      ["--schema=prisma/schema.prisma"],
      { dryRunLast: true },
    );

    // Still refused: the guard runs whatever the argument order.
    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/refusing to deploy migrations/);
  });

  it("allows a production deploy against a remote database", async () => {
    const result = await deploy({ NODE_ENV: "production", DATABASE_URL: NEON, DIRECT_URL: NEON });

    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/prisma migrate deploy/);
  });

  describe("addresses, in every spelling", () => {
    // The guard does not enumerate the ways of writing a loopback address —
    // there are more of them than anyone can list, and `postgresql://` is not
    // a WHATWG *special* scheme, so `new URL()` never canonicalises a numeric
    // host into dotted-quad form the way it does for `http://`. The rule is
    // inverted instead: a production deploy needs a *named* host, and an
    // address in any notation is not one.
    it.each([
      ["a decimal integer", "postgresql://relay:relay@2130706433:5435/relay"],
      ["a hexadecimal integer", "postgresql://relay:relay@0x7f000001:5435/relay"],
      ["octal dotted-quad", "postgresql://relay:relay@0177.0.0.1:5435/relay"],
      ["a short-form quad", "postgresql://relay:relay@127.1:5435/relay"],
      ["a mixed hex/decimal quad", "postgresql://relay:relay@0x7f.1:5435/relay"],
      ["an IPv4-mapped IPv6 literal", "postgresql://relay:relay@[::ffff:127.0.0.1]:5435/relay"],
      ["the same literal already collapsed", "postgresql://relay:relay@[::ffff:7f00:1]:5435/relay"],
      // Unbracketed, this is not a URL at all — so it lands in the
      // unparseable branch, which also refuses. Fail closed either way.
      ["an unbracketed IPv6 literal", "postgresql://relay:relay@::ffff:127.0.0.1/relay"],
      // Not loopback, and refused all the same: the rule is "a named host",
      // not "not a loopback address". A private-range address on the VPS is
      // exactly as much a not-Neon database as 127.0.0.1 is.
      ["a private-range IPv4 that is not loopback", "postgresql://relay:relay@10.0.0.5:5435/relay"],
      ["a public IPv4", "postgresql://relay:relay@203.0.113.9:5435/relay"],
    ])("refuses %s", async (_name, url) => {
      const result = await deployFromCopy({
        NODE_ENV: "production",
        DATABASE_URL: url,
        DIRECT_URL: url,
      });

      expect(result.code).not.toBe(0);
      expect(result.stderr).toMatch(/refusing to deploy migrations/);
    });

    it.each([
      ["localhost", "postgresql://relay:relay@localhost:5435/relay"],
      ["a localhost subdomain", "postgresql://relay:relay@db.localhost:5435/relay"],
      ["an mDNS name", "postgresql://relay:relay@vps.local:5435/relay"],
      ["a Docker-network name", "postgresql://relay:relay@postgres.internal:5435/relay"],
      ["a LAN name", "postgresql://relay:relay@nas.lan:5435/relay"],
      // A real DNS name, and still this machine. The committed guard listed
      // it by hand; the shape rule has to keep refusing it.
      ["the FQDN form of localhost", "postgresql://relay:relay@localhost.localdomain:5435/relay"],
      // A single label is a machine on this network by definition — there is
      // no public DNS name without a dot in it.
      ["a bare hostname", "postgresql://relay:relay@postgres:5435/relay"],
    ])("refuses %s", async (_name, url) => {
      const result = await deployFromCopy({
        NODE_ENV: "production",
        DATABASE_URL: url,
        DIRECT_URL: url,
      });

      expect(result.code).not.toBe(0);
      expect(result.stderr).toMatch(/refusing to deploy migrations/);
    });

    // `?host=` is not decoration: libpq — and so Prisma — connects to *that*
    // host and ignores the one in the authority. A URL whose authority is an
    // unresolvable public name and whose `?host=` is 127.0.0.1 reaches the
    // local database, which was checked against a running relay-pg: with the
    // parameter, `prisma migrate status` reports the schema up to date;
    // without it, P1001. So the override is what gets classified.
    it.each([
      ["an address", "postgresql://relay:relay@db.example.com:5435/relay?host=127.0.0.1"],
      ["a numeric address", "postgresql://relay:relay@db.example.com:5435/relay?host=2130706433"],
      ["localhost", "postgresql://relay:relay@db.example.com:5435/relay?host=localhost"],
      ["a socket directory", "postgresql://relay@db.example.com/relay?host=/var/run/postgresql"],
      ["nothing at all", "postgresql://relay:relay@db.example.com:5435/relay?host="],
    ])("refuses a remote-looking URL whose ?host= override points at %s", async (_name, url) => {
      const result = await deployFromCopy({
        NODE_ENV: "production",
        DATABASE_URL: url,
        DIRECT_URL: url,
      });

      expect(result.code).not.toBe(0);
      expect(result.stderr).toMatch(/refusing to deploy migrations/);
    });

    it("still allows a Neon host, which is what the rule has to leave through", async () => {
      const result = await deployFromCopy({ NODE_ENV: "production", DATABASE_URL: NEON, DIRECT_URL: NEON });

      expect(result.stderr).toBe("");
      expect(result.code).toBe(0);
    });
  });

  describe("connection strings a naive split reads as remote", () => {
    // Every one of these breaks a different string-cutting shortcut, and every
    // one breaks in the same direction: a host the guard reads as "not local"
    // and lets through.
    it.each([
      ["a unix socket", "postgresql://relay@/relay?host=/var/run/postgresql"],
      ["an unencoded slash in the password", "postgresql://relay:pa/ss@127.0.0.1:5435/relay"],
      ["a bracketed IPv6 loopback", "postgresql://relay:relay@[::1]:5435/relay"],
    ])("refuses %s", async (_name, url) => {
      const result = await deployFromCopy({ NODE_ENV: "production", DATABASE_URL: url, DIRECT_URL: url });

      expect(result.code).not.toBe(0);
      expect(result.stderr).toMatch(/refusing to deploy migrations/);
    });

    it("refuses a string it cannot parse at all, rather than guessing", async () => {
      const result = await deployFromCopy({
        NODE_ENV: "production",
        DATABASE_URL: "definitely not a url",
        DIRECT_URL: NEON,
      });

      expect(result.code).not.toBe(0);
      expect(result.stderr).toMatch(/cannot tell whether it is local/);
    });
  });

  it("refuses to run at all without both connection strings", async () => {
    // Run from a copy, because this repository may or may not have a local
    // .env depending on whose machine the suite is on, and the script now
    // reads one. A test whose result depends on that is not a test.
    const result = await deployFromCopy({ NODE_ENV: "production", DATABASE_URL: NEON });

    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/DIRECT_URL/);
  });

  describe("the local .env, which Prisma would have read", () => {
    it("supplies connection strings the process environment does not", async () => {
      const result = await deployFromCopy(
        { NODE_ENV: "development" },
        `DATABASE_URL="${LOCAL}"\nexport DIRECT_URL='${LOCAL}'\n# a comment\n`,
      );

      expect(result.stderr).toBe("");
      expect(result.code).toBe(0);
    });

    it("loses to the process environment, as dotenv precedence requires", async () => {
      // The deploy shell has Neon exported; the file on disk still says
      // Docker. The exported value must win, or a production deploy run from a
      // checkout with a local .env would be refused — or worse, retargeted.
      const result = await deployFromCopy(
        { NODE_ENV: "production", DATABASE_URL: NEON, DIRECT_URL: NEON },
        `DATABASE_URL="${LOCAL}"\nDIRECT_URL="${LOCAL}"\n`,
      );

      expect(result.stderr).toBe("");
      expect(result.code).toBe(0);
    });

    it("cannot switch the guard off with its own NODE_ENV", async () => {
      // docs/environment.md tells developers to put NODE_ENV=development in
      // .env for the app's benefit. If this script read it, a checkout would
      // carry permission to migrate a local database in a production shell —
      // a guard that a file on disk can disable.
      const result = await deployFromCopy(
        { DATABASE_URL: LOCAL, DIRECT_URL: LOCAL },
        `NODE_ENV=development\n`,
      );

      expect(result.code).not.toBe(0);
      expect(result.stderr).toMatch(/refusing to deploy migrations/);
    });

    it("strips an inline comment from an unquoted value", async () => {
      const result = await deployFromCopy(
        { NODE_ENV: "production" },
        `DATABASE_URL=${NEON} # pooled\nDIRECT_URL=${NEON} # direct\n`,
      );

      expect(result.stderr).toBe("");
      expect(result.code).toBe(0);
    });

    it("is still subject to the guard", async () => {
      const result = await deployFromCopy(
        { NODE_ENV: "production" },
        `DATABASE_URL="${LOCAL}"\nDIRECT_URL="${LOCAL}"\n`,
      );

      expect(result.code).not.toBe(0);
      expect(result.stderr).toMatch(/refusing to deploy migrations/);
    });
  });
});
