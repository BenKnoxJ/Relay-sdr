#!/usr/bin/env bash
#
# Apply migrations to the deployment database. `npm run db:deploy`.
#
# This is the named owner of the migration step in deploy/README.md. It is a
# wrapper around `prisma migrate deploy` and adds exactly one thing: it refuses
# to run against a local database unless the environment says, explicitly, that
# it is a development or test one.
#
# "Local" is decided by shape, not by a list of spellings:
# **production migrations go to a named host, never an address.** See
# classify_url below for what that admits and why the list came out.
#
# The accident it exists to stop is quiet. A shell that has been doing local
# work still exports the Docker connection string; the production migration
# step is run in that shell; Prisma connects to `relay` on 127.0.0.1, finds the
# migrations already applied, prints "No pending migrations" and exits 0. The
# deploy is reported green and Neon has not been touched. Nothing downstream
# can tell the difference, so the check belongs here, before the connection.
#
# The rule is an allowlist — silence is production — which is the same rule
# src/lib/env.ts applies to DEV_USER_EMAIL, and for the same reason. Asking "is
# NODE_ENV production?" makes every environment nobody anticipated permissive,
# and NODE_ENV is unset in an ordinary shell: a guard keyed on it being present
# would have fired nowhere at all. So an ordinary local run of this script needs
# `NODE_ENV=development` exported, exactly as docs/environment.md already
# requires for `npm run worker`.
#
# Both connection strings are checked. Prisma's migration engine connects over
# `directUrl` (DIRECT_URL) — a run with a Neon DATABASE_URL and a leftover
# local DIRECT_URL is the same accident, and checking only the pooled URL would
# let precisely the dangerous half through.

set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

dry_run=false
args=()
for arg in "$@"; do
  if [ "$arg" = "--dry-run" ]; then
    dry_run=true
  else
    # Everything else is Prisma's. Swallowing unknown flags would make
    # `db:deploy -- --schema=…` silently do something other than it says.
    args+=("$arg")
  fi
done

die() {
  echo "db-deploy: $*" >&2
  exit 1
}

# The value of `NAME=` in a local .env, or empty.
#
# Prisma loads .env itself, and docs/environment.md makes it the home of the
# local configuration — so a script that read only the process environment
# would refuse to run on every developer machine while Prisma, one line later,
# would have been perfectly happy. Read here rather than sourced: `.env` is
# data, and `source` would execute whatever a stray backtick did.
#
# Connection strings only. NODE_ENV is deliberately NOT read from this file:
# it is the variable that decides whether the guard applies, and a guard a
# checked-out file can switch off is not a guard. docs/environment.md tells
# developers to put `NODE_ENV=development` in .env for the app's benefit, which
# is exactly the file this must not consult.
from_dotenv() {
  local name=$1 line value
  [ -f .env ] || return 0
  line=$(grep -E "^[[:space:]]*(export[[:space:]]+)?${name}=" .env | tail -n 1) || true
  [ -n "$line" ] || return 0
  value=${line#*=}
  value=${value%$'\r'}
  value=${value#"${value%%[![:space:]]*}"}
  case $value in
    \"*)
      value=${value#\"}
      value=${value%%\"*}
      ;;
    \'*)
      value=${value#\'}
      value=${value%%\'*}
      ;;
    *)
      # Unquoted: dotenv treats an unquoted ` #` as the start of a comment, and
      # so must this, or the exported string carries the comment with it.
      value=${value%%#*}
      value=${value%"${value##*[![:space:]]}"}
      ;;
  esac
  printf '%s' "$value"
}

# The process environment wins, which is dotenv's own precedence and what makes
# a deploy shell able to override the file without editing it.
: "${DATABASE_URL:=$(from_dotenv DATABASE_URL)}"
: "${DIRECT_URL:=$(from_dotenv DIRECT_URL)}"
export DATABASE_URL DIRECT_URL

[ -n "${DATABASE_URL:-}" ] || die "DATABASE_URL is not set, and no .env supplied one."
[ -n "${DIRECT_URL:-}" ] || die "DIRECT_URL is not set, and no .env supplied one (Prisma migrates over the direct connection)."

# "local <host>", "remote <host>" or "unparseable", for one connection string.
#
# The rule, stated once: **production migrations go to a named host, never an
# address.** A connection string is "remote" only if its host is a DNS name —
# two or more labels of `[a-z0-9-]`, at least one of them containing a letter,
# with a top-level label that starts with one — and is not in a
# machine-local suffix (`localhost`, `*.localhost`, `*.localdomain`,
# `*.local`, `*.internal`, `*.lan`). Everything else is "local": every IPv4 literal in any notation,
# every IPv6 literal bracketed or not, a bare single-label hostname, an empty
# host, and a unix socket. A `?host=` parameter is what Prisma actually
# connects to, so it is classified by the same rule and can only widen the
# refusal, never narrow it.
#
# It is inverted deliberately. The first version of this guard enumerated the
# spellings of loopback — `localhost`, `::1`, `0.0.0.0`, `^127\.` — and that
# is unwinnable: `postgresql://` is not a WHATWG *special* scheme, so `new
# URL()` does not canonicalise numeric hosts the way it does for `http://`,
# and `2130706433`, `0x7f000001`, `0177.0.0.1`, `127.1`, `0x7f.1` and
# `[::ffff:127.0.0.1]` all reach `getaddrinfo` as 127.0.0.1 while reading as
# "some remote host" to a list of spellings. An allowlist of shapes has no
# such tail: anything unanticipated fails closed, into a refusal.
#
# Parsed by node rather than by cutting the string up in bash: userinfo that
# contains a `/`, an IPv6 literal in brackets, and a `?host=/var/run/postgresql`
# unix socket each break a different naive split, and every one of those breaks
# in the same direction. WHATWG URL gets them right, and anything it cannot
# parse is reported as such rather than guessed at.
#
# No name resolution. Resolving would answer a slightly different question
# ("where does this point *now*") at the cost of a network call in the guard
# and a failure mode — resolver down — that has to be handled anyway. The
# shape test needs neither and cannot be raced.
classify_url() {
  node -e '
    const raw = process.argv[1];
    let url;
    try {
      url = new URL(raw);
    } catch {
      // Includes an unbracketed IPv6 literal, which is not a URL at all.
      process.stdout.write("unparseable");
      process.exit(0);
    }

    // True only for a host this guard is willing to call remote.
    const named = (raw_host) => {
      // Brackets are IPv6 notation; a trailing dot is a fully-qualified name.
      const host = raw_host.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
      if (host === "") return false;

      // An IPv4 literal as `getaddrinfo` reads one: up to four parts, each
      // decimal, octal (leading zero) or hex (leading 0x). This is what makes
      // `0x7f.1` an address rather than a two-label name with a letter in it.
      const parts = host.split(".");
      const numeric =
        parts.length <= 4 &&
        parts.every((p) => /^(0[xX][0-9a-f]+|0[0-7]*|[1-9][0-9]*)$/.test(p));
      if (numeric) return false;

      // A DNS name: two or more labels, letters somewhere, and a top-level
      // label that begins with one. No public name is all digits.
      const dns =
        /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host) &&
        /^[a-z][a-z0-9-]*$/.test(parts[parts.length - 1]);
      if (!dns) return false;

      // Named, and named for this machine or this network.
      return !(
        host === "localhost" ||
        [".localhost", ".localdomain", ".local", ".internal", ".lan"].some((suffix) =>
          host.endsWith(suffix),
        )
      );
    };

    // `?host=` is not decoration. libpq — and so Prisma — connects to the host
    // in that parameter and ignores the one in the authority, so a URL whose
    // authority is an unresolvable public name and whose `?host=` is 127.0.0.1
    // reaches the local database. It is the host that gets connected to, so it
    // is the host that gets classified. A value starting with `/` is a unix
    // socket directory: this machine by definition.
    const override = url.searchParams.get("host");
    if (override !== null) {
      if (override.startsWith("/")) {
        process.stdout.write("local " + override);
        process.exit(0);
      }
      if (!named(override)) {
        process.stdout.write("local ?host=" + override);
        process.exit(0);
      }
    }

    // The authority host is checked even when an override supersedes it: no
    // legitimate deploy has a local authority and a remote override, and
    // refusing the pair costs nothing.
    process.stdout.write((named(url.hostname) ? "remote " : "local ") + url.hostname);
  ' "$1"
}

case "${NODE_ENV:-}" in
  development | test) ;;
  *)
    for name in DATABASE_URL DIRECT_URL; do
      classified=$(classify_url "${!name}")
      case "${classified%% *}" in
        local)
          die "refusing to deploy migrations: ${name} points at ${classified#* }, which is not a named remote host — production migrations go to a named host, never an address — and NODE_ENV is \"${NODE_ENV:-unset}\" rather than an explicit \"development\" or \"test\". The production database is Neon. Check the environment this shell inherited; if this really is a local run, export NODE_ENV=development."
          ;;
        unparseable)
          # Fail closed. An unreadable connection string is the one case where
          # "probably fine" is worth nothing: the whole point of this script is
          # to know which database it is about to migrate.
          die "refusing to deploy migrations: ${name} is not a connection string this script can read, so it cannot tell whether it is local."
          ;;
      esac
    done
    ;;
esac

if [ "$dry_run" = true ]; then
  echo "db-deploy: checks passed; would run: prisma migrate deploy ${args[*]-}"
  exit 0
fi

# The pinned CLI from node_modules, never `npx prisma`. With devDependencies
# absent — which is what `npm ci` under NODE_ENV=production leaves behind —
# `npx` would silently fetch some other version of Prisma from the registry and
# point it at Neon.
[ -x node_modules/.bin/prisma ] ||
  die "node_modules/.bin/prisma is missing. Run \`npm ci\` with devDependencies installed (NODE_ENV unset or not production) before deploying migrations."

exec node_modules/.bin/prisma migrate deploy ${args[@]+"${args[@]}"}
