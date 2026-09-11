import { Card } from "@/components/Card";
import { Chip } from "@/components/Chip";
import { DraftCard } from "@/components/DraftCard";
import { ItemLine } from "@/components/ItemLine";
import { PillButton } from "@/components/PillButton";
import { PlanCard } from "@/components/PlanCard";
import { Row } from "@/components/Row";
import type { AgentKind } from "@/lib/agents/definitions";
import { benchCopy } from "@/lib/copy/bench";
import { cn } from "@/lib/utils";
import { draftCopy } from "@/lib/copy/draft";
import { peopleCopy } from "@/lib/copy/people";
import { planCopy } from "@/lib/copy/plan";
import { startCopy } from "@/lib/copy/start";

import { leadgenOutputSchema, type LeadgenOutput } from "../../../../agents/leadgen/output.schema";
import {
  orchestratorOutputSchema,
  type OrchestratorOutput,
} from "../../../../agents/orchestrator/output.schema";
import { outreachInputSchema, type OutreachInput } from "../../../../agents/outreach/input.schema";
import { outreachOutputSchema, type MessageDraft } from "../../../../agents/outreach/output.schema";
import {
  packItems,
  planCards,
  researchRawSchema,
  type Item,
  type PackShape,
} from "../../../../agents/research/output.schema";

/**
 * A fixture's output, in the components a rep would meet it in.
 *
 * This file is the point of the bench. Everything else — the command, the
 * fixture format, the rubric checklist — exists so that these functions can be
 * handed a real output and draw the real screen. Nothing here reformats,
 * summarises or prettifies: if a pack reads badly in the plan cards, that is
 * the finding.
 *
 * Every renderer takes `unknown` and parses it with the definition's own
 * schema before touching a field. The fixture was validated when it was written
 * and re-validated on the way in, and parsing again here is what lets these
 * functions be typed at all without an `as`.
 */

/** Raw, for a kind with no screen yet — and for echo, which has no screen at all. */
export function RawOutput({ value }: { value: unknown }) {
  return (
    <pre className="type-mono overflow-x-auto rounded-input border border-line bg-ground p-4 text-12">
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}

/** How many distinct sources a set of items cites. */
function sourceCount(items: Item[]): number {
  return new Set(items.flatMap((item) => item.evidence.urls)).size;
}

/**
 * The plan cards (signed mock §3b-ii): four cards over the pack, plus the
 * unknowns card, with the first one expanded.
 *
 * The first archetype's pains are the expanded card because that is what the
 * mock draws expanded — the pack's own headline finding, every line with a
 * confidence word and a source.
 */
export function ResearchRender({ pack }: { pack: PackShape }) {
  // The cards are research v3's own plan-card view over the pack (§3 "Derived views").
  const view = planCards(pack);
  const [first] = view.archetypes;
  const pains = first?.pains ?? [];
  // `packItems` and not a walk of our own: the schema module already owns the
  // answer to "every item in a pack, wherever it sits", and a second copy here
  // would stop counting the first field somebody adds to it.
  const everyItem = packItems(pack);

  return (
    <Card label={planCopy.heading}>
      {/* The open card full width, the collapsed four in two columns: the
          signed mock's own `.packs` grid, which is what makes five cards read
          as one surface rather than a list. */}
      <div className="grid gap-2.5">
        <PlanCard
          open
          title={planCopy.card.pains}
          summary={first?.situation}
          note={`▾ ${pains.length} of ${pains.length} ${planCopy.count.shown}`}
        >
          {pains.map((pain) => (
            <ItemLine key={pain.id} item={pain} />
          ))}
        </PlanCard>
      </div>

      <div className="mt-2.5 grid gap-2.5 wide:grid-cols-2">
        <PlanCard
          title={planCopy.card.who}
          summary={view.summary[1] ?? view.summary[0]}
          note={`▸ ${view.archetypes.length} ${planCopy.count.groups} · ${sourceCount(everyItem)} ${planCopy.count.sources}`}
        />

        <PlanCard
          title={planCopy.card.hook}
          summary={view.hook?.text ?? ""}
          note={`▸ ${planCopy.count.whyNow}, ${view.hook?.answeredBy.length ?? 0} ${planCopy.count.items}`}
        />

        <PlanCard
          title={planCopy.card.firms}
          summary={view.seedFirms.map((firm) => firm.name).join(", ")}
          note={`▸ ${view.seedFirms.length} ${planCopy.count.firms} · ${planCopy.count.recipe}`}
        />

        <PlanCard
          dashed
          title={planCopy.card.unknowns}
          summary={view.unknowns.map((unknown) => unknown.text).join(" ")}
          note={`▸ ${view.unknowns.length} ${planCopy.count.unknowns} · ${planCopy.unknownsNote}`}
        />
      </div>
    </Card>
  );
}

/**
 * The Approve card (signed mock §2a).
 *
 * The draft alone is not the screen: the opener's evidence line, the person's
 * name and where the touch sits in the sequence all come from the agent's
 * INPUT, which is why a fixture carries one. The reference is resolved here
 * rather than in `DraftCard`, which takes the item it is to draw.
 */
/**
 * When a message goes, as the mock writes it: "Sends Thu 09:00".
 *
 * In UTC, deliberately. This is a server-rendered read-only card on a
 * development page, and formatting in the server's zone would make the same
 * fixture read differently on two machines — which is exactly the kind of
 * difference a design comparison must not contain.
 */
function dueLabel(dueAt: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "UTC",
  }).format(new Date(dueAt));
}

/**
 * What a draft's opener points at, or why it points at nothing.
 *
 * One function for both kinds of reference, because the two are one union in
 * the output schema (`openerSchema`) and a guard that covered only one of them
 * is exactly the gap this file's own comment warned about. A `person_fact`
 * names a lookup item; an `archetype_pain` names a pain in the pack. Either
 * is `dangling` when it names something that is not there.
 *
 * `dangling` is not the same as `item === null`. A `person_fact` on an
 * unusable lookup resolves to nothing legitimately — that is the ordinary
 * "no usable fact about this person" card — and `checkTouchLimits` has its
 * own rule (`opener-usable`) for it. An `archetype_pain` has no such
 * carve-out: the pack is always there, so a pain that cannot be found is
 * always a defect.
 */
export function resolveOpener(
  opener: MessageDraft["opener"],
  input: OutreachInput,
): { item: Item | null; dangling: boolean } {
  const pool: readonly Item[] =
    opener.kind === "person_fact" ? input.lookup.items : input.pack.archetype.pains;
  const item = pool.find((candidate) => candidate.id === opener.ref) ?? null;
  const expected = opener.kind === "archetype_pain" || input.lookup.usable;
  return { item, dangling: item === null && expected };
}

export function OutreachRender({ draft, input }: { draft: MessageDraft; input: OutreachInput }) {
  // A reference that resolves to nothing is NOT the same as opening on the
  // pain because there was no usable fact, and the card must not read as
  // though it were. The output schema cannot catch this — the thing being
  // referred to lives in the input — so it is caught here and said out loud,
  // in the outreach definition's own words for it (`checkTouchLimits`,
  // `opener-ref`). A bench that quietly drew a dangling opener as a clean card
  // would hide exactly the failure it exists to find.
  const opener = resolveOpener(draft.opener, input);

  return (
    <DraftCard
      draft={draft}
      who={`${input.person.name} · ${input.person.title}, ${input.person.company}`}
      note={draftCopy.touchKind[input.touch.kind]}
      opener={opener.item}
      openerProblem={opener.dangling ? draftCopy.openerMissing : undefined}
      chips={[peopleCopy.status[input.person.status], `${draftCopy.sends} ${dueLabel(input.touch.dueAt)}`]}
    />
  );
}

/** Your people (signed mock §3f), from a reveal. */
export function LeadgenRender({ output }: { output: LeadgenOutput }) {
  if (output.phase === "pick") {
    // Before the reveal there is no email status, so there is no `Row` to draw
    // — the chip on that row IS the status. The names and why each was picked
    // are what the screen has at this point, and that is what is shown.
    return (
      <Card label={peopleCopy.title}>
        <p className="type-small mb-2 text-muted">
          {output.found.n} of {output.found.ofM}
        </p>
        <ul className="grid gap-1.5">
          {output.chosen.map((person) => (
            <li key={person.id} className="type-body">
              <b className="type-name text-14">
                {person.name} · {person.title}
              </b>
              <span className="block text-12 text-muted">{person.whyPicked}</span>
            </li>
          ))}
        </ul>
      </Card>
    );
  }

  const counts = output.people.reduce<Record<string, number>>((total, person) => {
    total[person.status] = (total[person.status] ?? 0) + 1;
    return total;
  }, {});

  return (
    <Card label={peopleCopy.title} className="px-0 py-1">
      <p className="type-small px-5 pb-2 pt-1 text-muted">
        {[
          `${output.people.length} ${peopleCopy.people}`,
          ...Object.entries(counts).map(
            ([status, n]) => `${n} ${peopleCopy.status[status as keyof typeof peopleCopy.status]}`,
          ),
        ].join(" · ")}
      </p>
      {output.people.map((person, index) => (
        <Row key={person.id} person={person} rank={index + 1} />
      ))}
    </Card>
  );
}

/**
 * Start, pre-filled (signed mock §3d).
 *
 * A field Relay guessed is drawn with a dashed border, which is the signed
 * tokens file's own convention for it: "dashed border means Relay guessed".
 * Read-only, so the fields are text rather than inputs.
 */
export function OrchestratorRender({ output }: { output: OrchestratorOutput }) {
  if (output.step !== "pre-fill") {
    return (
      <Card>
        <p className="type-body">{output.step === "name" ? output.name : output.answer}</p>
      </Card>
    );
  }

  // The schema's field names on the left, because `guessed` names them, and
  // the mock's words on the right, because that is what a rep reads.
  const fields: [keyof typeof startCopy.field, string | undefined][] = [
    ["product", output.product],
    ["motion", output.motion],
    ["who", output.who],
    ["region", output.region],
    ["howMany", output.howMany?.toString()],
    ["weeks", output.weeks?.toString()],
    ["channels", output.channels?.join(", ")],
  ];

  return (
    <Card>
      <h2 className="type-heading mb-1.5">{startCopy.title}</h2>
      <p className="type-body mb-4 text-muted">{startCopy.understood}</p>
      <dl className="grid gap-2 wide:grid-cols-2">
        {fields.map(([name, value]) => {
          const guessed = output.guessed.includes(name);
          return (
            <div
              key={name}
              className={cn(
                "rounded-input border border-line px-3 py-2",
                // The signed convention: a dashed border means Relay guessed.
                guessed ? "border-dashed" : null,
              )}
            >
              <dt className="type-label">{startCopy.field[name]}</dt>
              <dd className="type-body">{value ?? startCopy.blank}</dd>
              {guessed ? (
                <Chip tone="warn" className="mt-1">
                  {startCopy.guessed}
                </Chip>
              ) : null}
            </div>
          );
        })}
      </dl>
      <div className="mt-4 flex items-center gap-chips">
        <PillButton disabled>{startCopy.start}</PillButton>
        <span className="type-small text-muted">{startCopy.startNote}</span>
      </div>
    </Card>
  );
}

/**
 * The screen for a fixture, or the raw output when its kind has none.
 *
 * Every branch parses with the agent's **own** schema, imported from
 * `agents/<kind>/output.schema.ts` — the same module the agent writes against
 * and `runAgent` validates with. That is plan conformance guard 2 at the last
 * possible moment: there is no cast here, so a component whose props stopped
 * matching its schema is a compile error rather than a screen that renders
 * something the agent can no longer produce.
 */
export function RenderFixture({
  kind,
  output,
  input,
}: {
  kind: AgentKind;
  output: unknown;
  input: unknown;
}) {
  switch (kind) {
    case "research": {
      // Research v3: what a rep meets is the pack the runtime assembles, not the loop's closing manifest.
      const parsed = researchRawSchema.safeParse(output);
      return parsed.success ? <ResearchRender pack={parsed.data} /> : <Unrenderable value={output} />;
    }
    case "outreach": {
      const draft = outreachOutputSchema.safeParse(output);
      const parsedInput = outreachInputSchema.safeParse(input);
      // A call draft has no card of its own yet — the call card is slice 1 —
      // and without the input there is no person and no opener to draw, which
      // is most of the screen.
      if (!draft.success || draft.data.kind !== "message" || !parsedInput.success) {
        return <Unrenderable value={output} />;
      }
      return <OutreachRender draft={draft.data} input={parsedInput.data} />;
    }
    case "leadgen": {
      const parsed = leadgenOutputSchema.safeParse(output);
      return parsed.success ? <LeadgenRender output={parsed.data} /> : <Unrenderable value={output} />;
    }
    case "orchestrator": {
      const parsed = orchestratorOutputSchema.safeParse(output);
      return parsed.success ? (
        <OrchestratorRender output={parsed.data} />
      ) : (
        <Unrenderable value={output} />
      );
    }
    case "echo":
      // Echo has no screen and is not owed one: it is the runtime's own proof,
      // and what a reader wants from it is the object.
      return <RawOutput value={output} />;
  }
}

/** A fixture whose kind has a screen, and which cannot be drawn on it. */
function Unrenderable({ value }: { value: unknown }) {
  return (
    <>
      <p className="type-small mb-2 text-warn">{benchCopy.cannotRender}</p>
      <RawOutput value={value} />
    </>
  );
}
