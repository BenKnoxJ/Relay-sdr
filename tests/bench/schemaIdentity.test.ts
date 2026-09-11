import { describe, expectTypeOf, it } from "vitest";

import { DraftCard } from "@/components/DraftCard";
import { EvidenceLine } from "@/components/EvidenceLine";
import { ItemLine } from "@/components/ItemLine";
import { Row } from "@/components/Row";

import type { RevealedPerson } from "../../agents/leadgen/output.schema";
import type { MessageDraft } from "../../agents/outreach/output.schema";
import type { Item } from "../../agents/research/output.schema";

/**
 * Plan conformance guard 2: one schema, three consumers.
 *
 * "The same zod schema is imported by the agent, the router and the component,
 * so a mismatch is a compile error." This file is where that sentence is held
 * to. Each assertion says a component's prop type is **exactly** the type zod
 * infers from the agent's own schema — not merely compatible with it, because
 * a component that accepts a wider shape would keep compiling after the schema
 * narrowed, and one that accepts a narrower shape would refuse output the agent
 * is allowed to produce.
 *
 * These are type assertions, so the check that matters happens in
 * `npm run typecheck` rather than in the run: `expectTypeOf` erases to nothing
 * at run time by design. That is the point — the guard is a compile error, and
 * `tsc --noEmit` covers `tests/**`. The `it` blocks are here so the file is
 * collected and a reader can see the guard in the suite output; the rendering
 * proof is `tests/ui/bench.test.tsx`.
 */

type PropsOf<T extends (props: never) => unknown> = T extends (props: infer P) => unknown ? P : never;

describe("component props are the agents' own schemas", () => {
  it("ItemLine takes the research contract's Item", () => {
    expectTypeOf<PropsOf<typeof ItemLine>["item"]>().toEqualTypeOf<Item>();
  });

  it("EvidenceLine takes the same Item", () => {
    expectTypeOf<PropsOf<typeof EvidenceLine>["item"]>().toEqualTypeOf<Item>();
  });

  it("DraftCard takes the outreach agent's message draft, and the Item it opened on", () => {
    expectTypeOf<PropsOf<typeof DraftCard>["draft"]>().toEqualTypeOf<MessageDraft>();
    expectTypeOf<PropsOf<typeof DraftCard>["opener"]>().toEqualTypeOf<Item | null>();
  });

  it("Row takes the lead gen agent's revealed person", () => {
    expectTypeOf<PropsOf<typeof Row>["person"]>().toEqualTypeOf<RevealedPerson>();
  });
});
