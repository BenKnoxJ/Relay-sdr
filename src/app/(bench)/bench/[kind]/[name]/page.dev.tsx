import Link from "next/link";
import { notFound } from "next/navigation";

import { RubricChecklist } from "../../RubricChecklist";
import { RenderFixture } from "../../renderers";

import { Card } from "@/components/Card";
import { PageHeader } from "@/components/PageHeader";
import { AGENT_KINDS, type AgentKind } from "@/lib/agents/definitions";
import { benchEnabled } from "@/lib/bench/devOnly";
import { fixtureNameSchema, readFixture, type BenchFixture } from "@/lib/bench/fixture";
import { automaticChecks, rubricFor } from "@/lib/bench/rubric";
import { benchCopy } from "@/lib/copy/bench";

/**
 * One fixture, on the screen a rep would see it on, with its rubric beside it.
 *
 * Three things on the page and in this order: what it cost, the screen, and the
 * checklist. The screen is the middle one deliberately — it is what the page is
 * for, and the numbers above it are context rather than the point.
 */
export const dynamic = "force-dynamic";

export default async function BenchFixturePage({
  params,
}: {
  params: Promise<{ kind: string; name: string }>;
}) {
  if (!benchEnabled()) notFound();

  const { kind, name } = await params;
  // The path is untrusted input even on a development page: `name` reaches
  // `path.join`, so it is held to the fixture-name slug before it does. A
  // traversal here would read an arbitrary file off the developer's disk and
  // print it on a page.
  if (!(AGENT_KINDS as readonly string[]).includes(kind)) notFound();
  if (!fixtureNameSchema.safeParse(name).success) notFound();

  let fixture: BenchFixture;
  try {
    fixture = readFixture(kind as AgentKind, name);
  } catch {
    notFound();
  }

  const run = fixture.run;

  return (
    <div className="mx-auto max-w-[900px] px-6 py-8">
      <PageHeader
        title={`${fixture.kind} · ${fixture.name}`}
        note={fixture.live ? benchCopy.live : benchCopy.recorded}
      />

      <p className="mb-grid">
        <Link href="/bench" className="type-small text-action underline">
          {benchCopy.back}
        </Link>
      </p>

      <div className="grid gap-grid">
        <Card label={benchCopy.whatItCost}>
          {run === null ? (
            <p className="type-body text-muted">{benchCopy.notRun}</p>
          ) : (
            <dl className="flex flex-wrap gap-6">
              <div>
                <dt className="type-label">{benchCopy.steps}</dt>
                <dd className="type-mono-big">{run.steps}</dd>
              </div>
              <div>
                <dt className="type-label">{benchCopy.spent}</dt>
                <dd className="type-mono-big">${run.cost}</dd>
              </div>
              <div>
                <dt className="type-label">{benchCopy.took}</dt>
                <dd className="type-mono-big">{run.durationMs}ms</dd>
              </div>
            </dl>
          )}
        </Card>

        <section aria-label={benchCopy.onScreen}>
          <h2 className="type-label mb-2.5">{benchCopy.onScreen}</h2>
          <RenderFixture kind={fixture.kind} output={fixture.output} input={fixture.input} />
        </section>

        <Card>
          <RubricChecklist
            storageKey={`relay.bench.${fixture.kind}.${fixture.name}`}
            automatic={automaticChecks(fixture)}
            rows={rubricFor(fixture.kind)}
          />
        </Card>
      </div>
    </div>
  );
}
