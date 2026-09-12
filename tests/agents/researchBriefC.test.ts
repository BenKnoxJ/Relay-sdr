import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { MODULE_IDS, SCOPE_ISSUE, lockScope, researchRawSchema, type LockedScope, type PackShape } from "../../agents/research/output.schema";
import { agentsDir } from "@/lib/agents/definitions";
import { loadFacts } from "@/lib/facts/load";
import { liveFactIds } from "@/lib/facts/schema";
import { KNOWLEDGE_SCRUB } from "@/lib/knowledge/load";
import { checkModuleWrite } from "@/lib/research/moduleWrite";
import { scoreRubric, type RubricRow } from "@/lib/research/rubric";

/**
 * Brief C, the deterministic regression for the insufficient stop and the
 * locked scope (research v3.2, §10 note 28). The fixture is what job
 * `adf47a2d` actually wrote on 2026-09-11 — m00, m01, m03 and m04 as stored,
 * every tool call in order, and the text of every page those modules cite —
 * plus the close its last message announced (marked synthetic: the run was
 * stopped before it closed).
 *
 * That run found the true market (two Orkney practices) and then met the
 * m03/m04 floors with answering bureaux, English groups and emergency centres
 * across Great Britain. Under v3.2 the same writes are refused, and the pack
 * the run was about to close with fails the rubric.
 */

type Loose = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const DIR = path.join(path.dirname(agentsDir()), "fixtures", "research");
const fixture = JSON.parse(readFileSync(path.join(DIR, "relay-c-orkney.v3.1.json"), "utf8")) as {
  brief: { region: string; scope: LockedScope };
  modules: Record<"m00" | "m01" | "m03" | "m04", Loose>;
  record: Array<{ run: number; name: string; module?: string; accepted?: boolean }>;
  announcedClose: { reason: string; widenings: Loose[] };
  pages: Record<string, string>;
};

const locked = lockScope(fixture.brief);
if (!locked.ok) throw new Error(locked.issue);
const scope = locked.scope;
const pageText = (url: string): string | undefined => fixture.pages[url];
const facts = loadFacts("insights360", 2).facts;
const live = liveFactIds(facts);
const now = new Date("2026-09-11T09:05:00Z");
const row = (rows: RubricRow[], check: number): RubricRow => rows.find((r) => r.check === check)!;
const content = (id: "m00" | "m01" | "m03" | "m04"): Loose => {
  const { status: _status, ...rest } = structuredClone(fixture.modules[id]);
  return rest;
};

/**
 * C's m04 as v3.2 needs it to parse: `country` filled with GB (every seed's
 * recipe says GB) and — the generous reading — `orgType` "veterinary
 * practice" on every firm, as if the model had claimed it. Only geography is
 * left to refuse them, which is the point: even a model that mislabels the
 * bureaux cannot place them in Orkney.
 */
function m04AsV32(): Loose {
  const m04 = content("m04");
  for (const t of m04.perArchetype) for (const f of t.seedFirms) Object.assign(f, { country: "GB", orgType: "veterinary practice" });
  return m04;
}

const OUTSIDE = ["Equicomms", "Kernow Vets Messaging", "Frontline Communications Group Ltd", "Goddard Veterinary Group", "Cedar Veterinary Group", "Willows Veterinary Group", "Vets Now (Dunfermline Contact Centre)"];

describe("brief C (vets in Orkney): the recorded run against v3.2", () => {
  it("locks the rep's scope: Great Britain, Orkney by any of its names, veterinary practices", () => {
    expect(scope).toMatchObject({ countries: ["GB"], places: [{ name: "Orkney" }], orgTypes: ["veterinary practice"], supplied: ["countries", "places", "orgTypes"] });
  });

  it("refuses the widened m04 on write: eight of ten seed firms are not in Orkney, and no recipe carries Orkney", () => {
    const accepted = { m00: fixture.modules.m00, m01: fixture.modules.m01, m03: fixture.modules.m03 };
    const check = checkModuleWrite("m04", m04AsV32(), { accepted, liveFactIds: live, now, scope, pageText });
    if (check.ok) throw new Error("expected a refusal");
    const scopeIssues = check.issues.filter((issue) => issue.startsWith(SCOPE_ISSUE));
    const placeIssues = scopeIssues.filter((issue) => /names none of the brief's places|cites no page that names/.test(issue));
    expect(placeIssues).toHaveLength(8);
    for (const name of OUTSIDE) expect(placeIssues.some((issue) => issue.includes(`(${name})`)), name).toBe(true);
    // The two Orkney practices pass: their region names Orkney and a page they cite does.
    expect(scopeIssues.some((issue) => issue.includes("(Northvet Veterinary Group Ltd)"))).toBe(false);
    expect(scopeIssues.some((issue) => issue.includes("(Flett & Carmichael Veterinary Surgeons)"))).toBe(false);
    expect(scopeIssues.filter((issue) => /must carry the brief's places in locations/.test(issue))).toHaveLength(4);
  });

  it("fails rows 8 and 14 on the pack the run was about to close with: widened modules and an insufficient block, but no persisted stop", () => {
    const pack = {
      modules: { ...fixture.modules, m04: { ...m04AsV32(), status: "complete" } },
      partial: true,
      missingModules: MODULE_IDS.filter((id) => !["m00", "m01", "m03", "m04"].includes(id)),
      scope,
      outcome: "insufficient",
      insufficient: { reason: fixture.announcedClose.reason, evidenceIds: [], widenings: fixture.announcedClose.widenings, decidedAt: "2026-09-11T09:12:14Z" },
    } as unknown as PackShape;
    const rows = scoreRubric({ pack, record: fixture.record, expectInsufficient: true, pageText });
    expect(row(rows, 8).verdict).toBe("fail");
    expect(row(rows, 8).detail).toMatch(/no persisted stop \(decideScope\)/);
    expect(row(rows, 8).detail).toMatch(/seed firm or recipe issue\(s\) outside the scope/);
    // Three options, two of them region — the old contract's "exactly three" invited padding; each must still widen.
    expect(row(rows, 14)).toMatchObject({ verdict: "fail", detail: expect.stringMatching(/Equicomms|Kernow|Frontline|Goddard|Cedar|Willows|Vets Now|Royal Veterinary College/) });
  });

  it("passes row 8 when the same run stops after m01: the Orkney evidence kept, genuine widenings, nothing after the stop", () => {
    const m01Write = fixture.record.findIndex((s) => s.name === "writeModule" && s.module === "m01" && s.accepted === true);
    // What v3.2 has the model do: m00 and m01 exactly as recorded, then decide — and research nothing more.
    const record = [...fixture.record.slice(0, m01Write + 1), { run: 0, name: "decideScope", verdict: "stop", accepted: true }];
    const northvet = ["m01-cl-northvet-staff-mix", "m01-trg-northvet-vacancy", "m01-trg-hivss-list-updated"];
    const pack = {
      modules: { m00: fixture.modules.m00, m01: fixture.modules.m01 },
      partial: true,
      missingModules: MODULE_IDS.filter((id) => id !== "m00" && id !== "m01"),
      scope,
      outcome: "insufficient",
      insufficient: {
        reason: "Orkney has two veterinary practices, Northvet and Flett & Carmichael, against a request for ten.",
        evidenceIds: northvet,
        widenings: [
          { dimension: "region", text: "Add the rest of the Highlands and Islands.", scopePatch: { places: [{ name: "Orkney" }, { name: "Highlands and Islands" }] } },
          { dimension: "sector", text: "Add the answering bureaux that take island practices' out-of-hours calls.", scopePatch: { orgTypes: ["veterinary practice", "veterinary answering service"] } },
        ],
        decidedAt: "2026-09-11T08:50:00Z",
      },
    } as unknown as PackShape;
    expect(researchRawSchema.safeParse(pack).success).toBe(true);
    const rows = scoreRubric({ pack, record, expectInsufficient: true, pageText });
    expect(row(rows, 8)).toMatchObject({ verdict: "pass" });
    expect(row(rows, 14).verdict).toBe("pass");
    // Stopping at m01 would have saved everything after it: C made 49 searches, 42 of them outside Orkney.
    expect(fixture.record.slice(m01Write + 1).filter((s) => s.name === "search").length).toBeGreaterThan(0);
  });

  it("carries no fleet codename or VPS path", () => {
    expect(KNOWLEDGE_SCRUB.exec(JSON.stringify(fixture))?.[0] ?? null).toBeNull();
  });
});
