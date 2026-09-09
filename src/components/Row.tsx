import { Chip, type ChipTone } from "./Chip";

import { peopleCopy } from "@/lib/copy/people";
import { cn } from "@/lib/utils";
import { initialsFor } from "@/lib/shell";

import type { RevealedPerson } from "../../agents/leadgen/output.schema";

/**
 * A person on Your people (signed tokens §4 "Row", signed mock §3f).
 *
 * The name in the inventory is `Row`, not `PersonRow`: the signed tokens file
 * fixes the slice 1 names so that slice 1 extends these components rather than
 * replacing them, and a second name here would mean building it twice.
 *
 * The prop is `RevealedPerson`, inferred from the lead gen agent's own output
 * schema. That is what makes the email status honest: the four words on the
 * screen are the four the schema allows, so a fifth state cannot be invented in
 * a component and a state the agent can produce cannot be forgotten by one.
 *
 * `state` — "replied · warm", "email 1 due", "call due" — is a caller's string
 * and not the person's, because it belongs to the campaign the row is being
 * read in and not to the reveal. Slice 1 supplies it; the bench leaves it out.
 */

/** The chip tone for an email status. Held is quiet, needs you is warn. */
const TONES: Record<RevealedPerson["status"], ChipTone> = {
  verified: "ok",
  held: "default",
  needs_you: "warn",
  bounced: "warn",
};

export function Row({
  person,
  rank,
  state,
  className,
}: {
  person: RevealedPerson;
  rank?: number;
  /** Where they are in the sequence, in one word. */
  state?: string;
  className?: string;
}) {
  return (
    <div className={cn("flex items-center gap-3 px-5 py-2.5", className)}>
      {rank === undefined ? null : (
        <span className="type-mono w-5 shrink-0 text-11 text-muted">{rank}</span>
      )}
      <span
        aria-hidden="true"
        className={cn(
          "type-mono grid h-8 w-8 shrink-0 place-items-center rounded-pill bg-soft text-11",
          person.status === "needs_you" ? "text-warn" : "text-action",
        )}
      >
        {initialsFor(person.name, person.email ?? "")}
      </span>
      <span className="min-w-0 flex-1">
        <b className="type-name block truncate text-14">
          {person.name} · {person.title}
        </b>
        <span className="type-small block truncate text-muted">
          {[person.company, person.city].filter((part) => part !== undefined).join(" · ")}
        </span>
      </span>
      <Chip tone={TONES[person.status]}>{peopleCopy.status[person.status]}</Chip>
      {state === undefined ? null : (
        <span className="type-mono shrink-0 text-11 text-muted">{state}</span>
      )}
    </div>
  );
}
