import type { BuyerRole, RolePart } from "../../../agents/leadgen/input.schema";

import { containsPhrase, norm } from "./normalise";

/**
 * Role matching, leadgen v2.2 §8a. Code only, per confirmed group: the table
 * is built from that group's own roles, so the same title can be one part in
 * one group and another part in the next. There is no global title-to-role
 * mapping anywhere.
 *
 * Research writes compound role titles ("Head of Claims / Claims Operations
 * Manager", "Claims Director or Chief Operating Officer"). Each is split on
 * Research's own " / " and " or ", and each piece is normalised. A title that
 * equals a piece is an exact match; a title that contains a meaningful piece
 * of two or more words as a whole phrase is a phrase match. A single word
 * ("analyst", "manager") never matches by containment, and neither does a
 * piece made only of generic words. Matches that point at different parts
 * are no match: the person is a Related role, never a guess.
 */

export type { RolePart };

export type RoleMatch = { part: RolePart; title: string; how: "exact" | "phrase" };

/** Words that say how senior someone is, not what they do. */
const GENERIC = new Set([
  "head",
  "of",
  "and",
  "the",
  "chief",
  "officer",
  "manager",
  "director",
  "lead",
  "senior",
  "analyst",
  "executive",
  "deputy",
  "assistant",
  "team",
  "leader",
  "vice",
  "president",
  "vp",
]);

/** The order parts are preferred in: runs leads for the Direct motion (v2.2 §8a). */
export const PART_ORDER: readonly RolePart[] = ["runs", "champions", "signs"];

type Piece = { phrase: string; meaningful: boolean; role: BuyerRole };

export type RoleTable = { pieces: readonly Piece[] };

/** A role title's pieces, split on Research's own " / " and " or ". */
export function rolePieces(title: string): string[] {
  return title
    .split(/\s*\/\s*|\s+or\s+/i)
    .map(norm)
    .filter((piece) => piece !== "");
}

export function roleTable(roles: readonly BuyerRole[]): RoleTable {
  return {
    pieces: roles.flatMap((role) =>
      rolePieces(role.title).map((phrase) => {
        const words = phrase.split(" ");
        return { phrase, meaningful: words.length >= 2 && words.some((word) => !GENERIC.has(word)), role };
      }),
    ),
  };
}

/** The one role every piece agrees on, the first in Research's order; null when they disagree on the part. */
function agreed(pieces: readonly Piece[], how: RoleMatch["how"]): RoleMatch | null {
  const first = pieces[0];
  if (first === undefined) return null;
  if (pieces.some((piece) => piece.role.part !== first.role.part)) return null;
  return { part: first.role.part, title: first.role.title, how };
}

/** Which of the group's roles a title plays, and how confidently; null is a Related role. */
export function matchRole(title: string, table: RoleTable): RoleMatch | null {
  const key = norm(title);
  if (key === "") return null;
  const exact = table.pieces.filter((piece) => piece.phrase === key);
  if (exact.length > 0) return agreed(exact, "exact");
  return agreed(
    table.pieces.filter((piece) => piece.meaningful && containsPhrase(key, piece.phrase)),
    "phrase",
  );
}

/** The recipe's titles by the part each one matches; titles that match none are left out. */
export function titlesByPart(titles: readonly string[], table: RoleTable): Record<RolePart, string[]> {
  const byPart: Record<RolePart, string[]> = { runs: [], champions: [], signs: [] };
  for (const title of titles) {
    const match = matchRole(title, table);
    if (match !== null && !byPart[match.part].includes(title)) byPart[match.part].push(title);
  }
  return byPart;
}
