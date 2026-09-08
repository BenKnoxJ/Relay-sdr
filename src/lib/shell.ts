/**
 * The small pure decisions the shell makes about a person and a date.
 *
 * They live here rather than in the pages that use them for a mundane reason
 * and a good one: Next refuses a page or layout module that exports anything
 * but its own reserved fields, so a helper defined beside a route cannot be
 * tested without being re-exported through something else. And they are worth
 * testing — every one of them has an input that a real account produces and a
 * naive version gets wrong.
 *
 * No imports on purpose: nothing here needs the database, the session or the
 * copy files — which also means the client may import it. That matters for
 * `SENTENCE_MAX`: the form and the input schema have to agree, and reaching
 * for the router's copy of it from a client component would pull the router,
 * tRPC and Prisma into the browser bundle.
 */

/** The longest sentence Home's brief box takes, for the form and the schema. */
export const SENTENCE_MAX = 2000;

/** The words of a name, with the empties dropped. */
function words(name: string | null): string[] {
  return (name ?? "").trim().split(/\s+/).filter((word) => word !== "");
}

/**
 * The name a rep is greeted by (signed mock 1b, "Welcome, Ben").
 *
 * Clerk lets every part of a name be empty, and the local bypass supplies none
 * at all, so the address is the fallback: "ben@example.test" greets Ben. It is
 * a worse greeting than a real first name and a much better one than
 * "Welcome, ".
 */
export function firstNameFor(name: string | null, email: string): string {
  const [first] = words(name);
  if (first !== undefined) return first;

  const local = email.split("@")[0];
  if (local === undefined || local === "") return email;

  // Corporate addresses are mostly `first.last`, `first_last` or `first-last`,
  // so the first segment is the first name and the rest is not. Without this
  // the bypass greets "Ben.knox-johnston", which is the case a developer
  // actually sees.
  const [head] = local.split(/[._+-]/);
  const chosen = head === undefined || head === "" ? local : head;

  // Capitalised, because it is being used as a name: "Welcome, ben" reads as a
  // bug and "Welcome, Ben" reads as a greeting. Only the fallback is touched —
  // a name the person gave is written the way they gave it.
  return `${chosen[0]?.toUpperCase() ?? ""}${chosen.slice(1)}`;
}

/**
 * The avatar's two letters (signed mock, `.me`).
 *
 * First and last initial where there are two words, so "Ben Knox-Johnston" is
 * BK; the first two letters of a single name; the first two of the address
 * when there is no name at all. Never empty, because an empty circle in the
 * nav reads as a broken image rather than as a person with no name.
 */
export function initialsFor(name: string | null, email: string): string {
  const parts = words(name);
  if (parts.length >= 2) {
    return `${parts[0]?.[0] ?? ""}${parts[parts.length - 1]?.[0] ?? ""}`.toUpperCase();
  }
  if (parts.length === 1) return (parts[0] as string).slice(0, 2).toUpperCase();
  return email.slice(0, 2).toUpperCase();
}

/**
 * "Mon 7 Sep", as the signed mock has it.
 *
 * The zone is named rather than left to the machine. This renders on a server
 * that is not in the reader's timezone, and "today" on Home meaning the
 * server's today is the kind of wrong that only appears after 23:00. The pilot
 * is a UK team (master doc §23.1d, region default), so that is the clock Relay
 * keeps until there is a per-rep timezone to keep instead.
 */
export function dateLabel(now: Date): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: "Europe/London",
  }).formatToParts(now);

  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((candidate) => candidate.type === type)?.value ?? "";

  // Assembled rather than taken whole, for two reasons. en-GB's short month
  // for September is "Sept", four letters, and the signed mock says "Sep"; and
  // the order of the parts is the locale's to decide, while the signed line is
  // weekday, day, month whatever the runtime's ICU data thinks.
  return `${part("weekday")} ${part("day")} ${part("month").slice(0, 3)}`;
}
