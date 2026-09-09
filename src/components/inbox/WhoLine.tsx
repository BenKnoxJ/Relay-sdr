import { inboxCopy } from "@/lib/copy/inbox";
import type { Person } from "@/lib/fixtures/inbox";

/**
 * The first line of every card: who, and one mono word on the right saying
 * which touch this is or when it came (mock section 2, `.dc .who`).
 *
 * The name is the card's heading. There is exactly one `h2` per card, so the
 * card reads as one thing to a screen reader and the queue's three headings
 * stay the page's only other ones.
 */
export function WhoLine({ person, aside }: { person: Person; aside: string }) {
  return (
    <div className="mb-3 flex items-baseline justify-between gap-3">
      <h2 className="type-name text-16">
        {person.name}
        {inboxCopy.join}
        {person.title}, {person.company}
      </h2>
      <span className="type-mono shrink-0 text-12 text-muted">{aside}</span>
    </div>
  );
}
