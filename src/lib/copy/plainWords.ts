/**
 * The rep-words rule (master doc §22.4, principle 4), in one place.
 *
 * Relay never puts its own machinery on a rep's screen. A rep does not have
 * enrolments, cohorts or agent runs; they have people to call and replies to
 * send. This file holds the banned list and the two assertions that enforce it,
 * so the test that sweeps `src/lib/copy/*` and a router checking its own
 * response are reading the same rule rather than two copies of it that drift.
 *
 * It is NOT a copy file: it exports no on-screen string, and the copy sweep
 * skips it by name.
 *
 * Amending the list: a word comes off it when a signed screen needs it, and
 * goes on it when machine vocabulary leaks. Both are a decision, not a fix.
 */

/**
 * Machine vocabulary, word-boundary and case-insensitive, plural-aware.
 *
 * Two groups: what the platform calls its own parts, and the fleet's agent
 * codenames — a rep should never learn that a thing called Prism wrote their
 * message.
 *
 * Deliberately absent, and different from the Sales360 list this is carried
 * from (D1, approved 2026-09-07): `outcome`, `sequence`, `campaign`, `draft`,
 * `reply`, `call` and `credit`. Every one of them is on a signed screen in a
 * rep's own words — "Log the outcome" is the call card's primary action.
 *
 * No `g` flag on purpose: a `/g/` regex carries `lastIndex` between calls and
 * would alternate true and false on the same string.
 */
export const MACHINE_WORDS =
  /\b(agent run|run id|orchestrator|specialist|enrolment|cohort|persona|archetype|autopilot|verdict|judge|gate|stage|module|pipeline|payload|prompt|token|model|job|icp|llm|touch|signal|pitch|prism|forge|critic|sentinel|scribe|neon|glitch|atlas|iris|vector|canvas)(s|es)?\b/i;

/**
 * An em dash anywhere, or an en dash with a space on either side.
 *
 * An em dash never reaches a rep, and an en dash may only join a range (9–5),
 * never stand in for a comma. The house style is a full stop or a comma.
 */
export const BANNED_DASHES = /—|\s–|–\s/;

/**
 * Every string reachable from a value, with the path that leads to it.
 *
 * `seen` is not an optimisation: superjson payloads and Prisma rows with a
 * back-relation are cyclic, and without it a router calling `assertPlainWords`
 * on its own response dies with a stack overflow instead of a verdict.
 */
function strings(
  value: unknown,
  path: string,
  out: [string, string][],
  seen: WeakSet<object>,
): void {
  if (typeof value === "string") {
    out.push([path, value]);
    return;
  }
  if (typeof value !== "object" || value === null) return;
  if (seen.has(value)) return;
  seen.add(value);

  if (Array.isArray(value)) {
    value.forEach((item, i) => strings(item, `${path}[${i}]`, out, seen));
    return;
  }
  // A Map's values and a Set's members are strings a rep reads too, and
  // Object.entries() reports neither: both would otherwise walk past unchecked.
  if (value instanceof Map) {
    for (const [key, inner] of value) strings(inner, `${path}.get(${String(key)})`, out, seen);
    return;
  }
  if (value instanceof Set) {
    let i = 0;
    for (const inner of value) strings(inner, `${path}<${i++}>`, out, seen);
    return;
  }
  for (const [key, inner] of Object.entries(value)) strings(inner, `${path}.${key}`, out, seen);
}

/** Every string in `value`, so a caller can check them all and report each one. */
export function readableStrings(value: unknown, path = "$"): [string, string][] {
  const out: [string, string][] = [];
  strings(value, path, out, new WeakSet());
  return out;
}

/**
 * Refuse a machine word in anything a rep would read.
 *
 * String VALUES only: keys are skipped on purpose. `enrolmentId` and `touchId`
 * are field names the client uses, never words on a screen, and checking the
 * serialised JSON failed on those instead of on the copy.
 *
 * **Apply it to copy and to the fixed strings a response is assembled from, not
 * to a whole response containing customer data.** The list holds ordinary
 * English and thirteen first names: "Iris Chen", "Atlas Copco", "Vector
 * Capital" and a subject line reading "Re: pricing model" are all real values
 * from a CRM, and all of them match. A router that checks its own output
 * should check the copy it chose, and leave the person's own words alone.
 */
export function assertPlainWords(value: unknown): void {
  for (const [path, text] of readableStrings(value)) {
    if (MACHINE_WORDS.test(text)) {
      throw new Error(`machine word in a rep-facing string at ${path}: ${text.slice(0, 400)}`);
    }
  }
}

/**
 * The machine words that are machine words in prose too.
 *
 * `MACHINE_WORDS` is the list for copy: there, "judge", "gate", "stage",
 * "signal", "touch", "job", "model", "token", "pipeline", "module" and
 * "specialist" are Relay's own nouns leaking onto a screen. In a paragraph an
 * agent writes about a market they are ordinary English — an operations lead
 * *judges* a change, a firm hires from a *job* advert, an insurer is a
 * *specialist* one, an administrator *pitches* its service, a *critic* of the
 * regulator is quoted — and refusing a research pack over them cost four live
 * runs on 2026-09-09. The fleet's codenames are all ordinary English words too
 * and mean nothing to a rep, so prose keeps only the runtime's own nouns.
 */
export const PROSE_MACHINE_WORDS =
  /\b(agent run|run id|orchestrator|enrolment|cohort|persona|archetype|autopilot|verdict|payload|prompt|icp|llm)(s|es)?\b/i;

/** `assertPlainWords` for paragraphs an agent composed, with the prose list. */
export function assertPlainProse(value: unknown): void {
  for (const [path, text] of readableStrings(value)) {
    if (PROSE_MACHINE_WORDS.test(text)) {
      throw new Error(`machine word in a rep-facing string at ${path}: ${text.slice(0, 400)}`);
    }
  }
}

/** Refuse an em dash, or an en dash standing in for punctuation. */
export function assertPlainDashes(value: unknown): void {
  for (const [path, text] of readableStrings(value)) {
    if (BANNED_DASHES.test(text)) {
      throw new Error(`banned dash in a rep-facing string at ${path}: ${text.slice(0, 400)}`);
    }
  }
}
