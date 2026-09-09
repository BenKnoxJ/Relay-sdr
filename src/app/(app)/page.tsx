import { HomeDayOne } from "@/components/HomeDayOne";
import { dateLabel, firstNameFor } from "@/lib/shell";
import { me } from "@/server/api/caller";

import { startBrief } from "./actions";

/**
 * Home (master doc §23.1, §23.1a). Day one today: a single card with the brief
 * box, because there is no campaign to navigate to yet.
 *
 * The page resolves who is signed in and what they have connected, formats the
 * date, and hands both to a component that knows nothing about any of it.
 * Next refuses a page module that exports anything else, so the two helpers it
 * needs live in `src/lib/shell.ts` where a test can reach them.
 */
export default async function HomePage() {
  const who = await me();

  return (
    <HomeDayOne
      firstName={firstNameFor(who.name, who.email)}
      today={dateLabel(new Date())}
      connections={who.connections}
      startBrief={startBrief}
    />
  );
}
