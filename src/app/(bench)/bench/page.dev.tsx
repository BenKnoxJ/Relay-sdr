import Link from "next/link";
import { notFound } from "next/navigation";

import { Card } from "@/components/Card";
import { Chip } from "@/components/Chip";
import { EmptyState } from "@/components/EmptyState";
import { PageHeader } from "@/components/PageHeader";
import { benchEnabled } from "@/lib/bench/devOnly";
import { listFixtures, readFixture } from "@/lib/bench/fixture";
import { benchCopy } from "@/lib/copy/bench";

/**
 * The bench index: every checked-in output, by agent.
 *
 * `.dev.tsx`, not `.tsx`. `pageExtensions` in `next.config.mjs` only counts
 * that suffix in development, so a production build does not compile this file
 * as a route and there is nothing at `/bench` to reach. `benchEnabled()` is the
 * second gate, for a build made with `NODE_ENV=development` and then served.
 * Sign-in is a third: `src/middleware.ts` protects every page by default, so
 * `/bench` is behind it without being named anywhere.
 *
 * Read off disk on every request. It is a development page over a directory a
 * developer is actively writing into, and a cached list would be the one thing
 * more annoying than a slow one.
 */
export const dynamic = "force-dynamic";

export default function BenchIndex() {
  if (!benchEnabled()) notFound();

  const groups = listFixtures();

  return (
    <div className="mx-auto max-w-[900px] px-6 py-8">
      <PageHeader title={benchCopy.title} note={benchCopy.note} />

      {groups.length === 0 ? (
        <Card>
          <EmptyState heading={benchCopy.emptyHeading} body={benchCopy.emptyBody} />
        </Card>
      ) : (
        <div className="grid gap-grid">
          {groups.map((group) => (
            <Card key={group.kind} label={group.kind}>
              <ul className="grid gap-1.5">
                {group.names.map((name) => {
                  // Read here rather than in a second pass, so a fixture that
                  // no longer parses is one broken line on the index instead of
                  // a page that will not render at all.
                  let summary: { ok: boolean; source: string } | null = null;
                  // A file that is not a fixture at all is a different problem
                  // from an output that does not validate, and the message
                  // says which — "not as promised" on both would send a reader
                  // looking at the agent when the fault is in the file.
                  let unreadable: string | null = null;
                  try {
                    const fixture = readFixture(group.kind, name);
                    summary = {
                      ok: fixture.validation.ok,
                      source: fixture.source === "run" ? benchCopy.sourceRun : benchCopy.sourceSample,
                    };
                  } catch (error) {
                    unreadable = error instanceof Error ? error.message : String(error);
                  }
                  return (
                    <li key={name} className="flex flex-wrap items-center gap-2.5">
                      <Link href={`/bench/${group.kind}/${name}`} className="type-name text-14 text-action underline">
                        {name}
                      </Link>
                      {summary === null ? (
                        <span className="type-small text-warn">{unreadable}</span>
                      ) : (
                        <>
                          <Chip tone={summary.ok ? "ok" : "warn"}>
                            {summary.ok ? benchCopy.chipOk : benchCopy.chipBad}
                          </Chip>
                          <span className="type-mono text-11 text-muted">{summary.source}</span>
                        </>
                      )}
                    </li>
                  );
                })}
              </ul>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
