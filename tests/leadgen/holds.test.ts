import { describe, expect, it } from "vitest";

import { DEFAULT_EMAIL_POLICY, Knowledge, evaluateReveal, preRevealChecks, type RevealOutcome } from "@/lib/leadgen/holds";

import { candidate, crm, handoff, knowledge } from "./harness";

/** Reuse, identity and holds, leadgen v2.1 §7 and §9, over injected knowledge. */

const NO_PLACES = new Set<string>();
const person = { id: "person-1", email: "sam@firm1.co.uk", emailType: "work" as const, grade: "A" };

describe("before reveal", () => {
  it("does not re-buy a provider record known to be unusable", () => {
    for (const status of ["no_email", "invalid_id", "wrong_person"] as const) {
      const known = new Knowledge(knowledge({ providerIdentities: [{ provider: "lusha", providerId: "l-001", personId: null, status }] }));
      expect(preRevealChecks(candidate(1), handoff(), known, NO_PLACES)).toEqual({ kind: "held", reason: "provider_unusable" });
    }
  });

  it("does not let an unusable record block the same human reached through another record", () => {
    const known = new Knowledge(
      knowledge({
        people: [person],
        providerIdentities: [
          { provider: "lusha", providerId: "l-001", personId: null, status: "wrong_person" },
          { provider: "lusha", providerId: "l-002", personId: "person-1", status: "usable" },
        ],
      }),
    );
    expect(preRevealChecks(candidate(2), handoff(), known, NO_PLACES)).toEqual({ kind: "eligible", reused: person });
  });

  it("reuses a person Relay already owns, and does not hold them for existing elsewhere", () => {
    const known = new Knowledge(knowledge({ people: [person], providerIdentities: [{ provider: "lusha", providerId: "l-001", personId: "person-1", status: "usable" }] }));
    expect(preRevealChecks(candidate(1), handoff(), known, NO_PLACES)).toEqual({ kind: "eligible", reused: person });
  });

  it("holds a domain under the organisation's do-not-contact list", () => {
    const known = new Knowledge(knowledge({ suppressions: [{ kind: "domain", value: "www.firm1.co.uk", reason: "dnc" }] }));
    expect(preRevealChecks(candidate(1), handoff(), known, NO_PLACES)).toEqual({ kind: "held", reason: "dnc" });
  });

  it("never applies an email suppression to a preview, which has no email", () => {
    const known = new Knowledge(knowledge({ suppressions: [{ kind: "email", value: "person.1@firm1.co.uk", reason: "opted_out" }] }));
    expect(preRevealChecks(candidate(1), handoff(), known, NO_PLACES)).toEqual({ kind: "eligible", reused: null });
  });

  it("holds the brief's excluded firms by domain, or by name when no domain was given", () => {
    const research = handoff((h) => (h.exclusions.firms = [{ name: "Old Rival", domain: "oldrival.co.uk" }, { name: "Named Only Ltd" }]));
    const known = new Knowledge(knowledge());
    expect(preRevealChecks(candidate(1, { domain: "https://oldrival.co.uk" }), research, known, NO_PLACES)).toEqual({ kind: "held", reason: "excluded_firm" });
    expect(preRevealChecks(candidate(2, { company: "Named Only" }), research, known, NO_PLACES)).toEqual({ kind: "held", reason: "excluded_firm" });
  });

  it("holds excluded titles and roles as whole phrases", () => {
    const research = handoff((h) => (h.exclusions.roles = ["Receptionist"]));
    const known = new Knowledge(knowledge());
    expect(preRevealChecks(candidate(1, { title: "Senior Claims Handler" }), research, known, NO_PLACES)).toEqual({ kind: "held", reason: "excluded_title" });
    expect(preRevealChecks(candidate(2, { title: "Head Receptionist" }), research, known, NO_PLACES)).toEqual({ kind: "held", reason: "excluded_title" });
    expect(preRevealChecks(candidate(3, { title: "Handlers Manager" }), research, known, NO_PLACES).kind).toBe("eligible");
  });

  it("holds anyone outside the recipe's countries or places, and anyone whose location is missing", () => {
    const known = new Knowledge(knowledge());
    expect(preRevealChecks(candidate(1, { countryIso2: "IE" }), handoff(), known, NO_PLACES).kind).toBe("held");
    expect(preRevealChecks(candidate(2, { countryIso2: undefined }), handoff(), known, NO_PLACES).kind).toBe("held");
    const orkney = handoff((h) => (h.targeting.locations = ["Orkney"]));
    const places = new Set(["orkney", "orkney islands"]);
    expect(preRevealChecks(candidate(3, { state: "Orkney Islands", city: "Kirkwall" }), orkney, known, places).kind).toBe("eligible");
    expect(preRevealChecks(candidate(4, { city: "Leeds" }), orkney, known, places)).toEqual({ kind: "held", reason: "wrong_geography" });
    expect(preRevealChecks(candidate(5, { city: undefined, state: undefined }), orkney, known, places)).toEqual({ kind: "held", reason: "wrong_geography" });
  });
});

describe("after reveal", () => {
  const ok = { status: "ok" as const, name: "Person 1", domain: "firm1.co.uk", email: "person.1@firm1.co.uk", emailType: "work" as const, grade: "A" };

  async function reveal(answer: Parameters<typeof evaluateReveal>[1], options: { known?: ReturnType<typeof knowledge>; check?: ReturnType<typeof crm>; inCampaign?: string[]; grades?: string[] } = {}): Promise<RevealOutcome> {
    return evaluateReveal(
      candidate(1),
      answer,
      new Knowledge(options.known ?? knowledge()),
      options.check ?? crm(),
      options.grades === undefined ? DEFAULT_EMAIL_POLICY : { allowedGrades: options.grades },
      new Set(options.inCampaign ?? []),
    );
  }

  it("marks the provider record, and creates no Person, when the reveal is invalid, wrong or empty", async () => {
    expect(await reveal({ status: "invalid_id" })).toMatchObject({ kind: "held", reason: "invalid_id", identity: { status: "invalid_id", personId: null } });
    expect(await reveal({ ...ok, name: "Someone Else" })).toMatchObject({ kind: "held", reason: "wrong_person", identity: { status: "wrong_person" } });
    expect(await reveal({ ...ok, domain: "elsewhere.example" })).toMatchObject({ reason: "wrong_person" });
    const empty = await reveal({ ...ok, email: undefined });
    expect(empty).toMatchObject({ kind: "held", reason: "no_email", identity: { status: "no_email", personId: null } });
    expect("person" in empty).toBe(false);
  });

  it("links a reveal to an existing Person not yet in this campaign, and carries on", async () => {
    const known = knowledge({ people: [{ ...person, email: "person.1@firm1.co.uk" }] });
    expect(await reveal(ok, { known })).toMatchObject({
      kind: "ready",
      person: { existing: true, personId: "person-1" },
      identity: { providerId: "l-001", status: "usable", personId: "person-1" },
    });
  });

  it("holds the extra record as a duplicate only when that Person is already in this campaign", async () => {
    const known = knowledge({ people: [{ ...person, email: "person.1@firm1.co.uk" }], enrolledPersonIds: ["person-1"] });
    expect(await reveal(ok, { known })).toMatchObject({ kind: "held", reason: "duplicate_in_campaign" });
    const elsewhere = knowledge({ people: [{ ...person, email: "person.1@firm1.co.uk" }] });
    expect(await reveal(ok, { known: elsewhere, inCampaign: ["person-1"] })).toMatchObject({ reason: "duplicate_in_campaign" });
  });

  it("holds an opted-out or do-not-contact email, and writes the org-wide opt-out only when the CRM says so", async () => {
    const suppressed = await reveal(ok, { known: knowledge({ suppressions: [{ kind: "email", value: "PERSON.1@firm1.co.uk", reason: "dnc" }] }) });
    expect(suppressed).toMatchObject({ kind: "held", reason: "dnc" });
    expect("suppress" in suppressed).toBe(false);
    const fromCrm = await reveal(ok, { check: crm({ optOutEmails: ["person.1@firm1.co.uk"] }) });
    expect(fromCrm).toMatchObject({ kind: "held", reason: "opted_out", suppress: { kind: "email", value: "person.1@firm1.co.uk", reason: "opted_out" } });
  });

  it("applies this campaign's rules without writing anything org-wide", async () => {
    const outcomes = [
      await reveal(ok, { check: crm({ customerEmails: ["person.1@firm1.co.uk"] }) }),
      await reveal({ ...ok, emailType: "personal" }),
      await reveal({ ...ok, grade: "B" }),
      await reveal({ ...ok, grade: null }),
    ];
    expect(outcomes.map((outcome) => (outcome.kind === "held" ? outcome.reason : outcome.kind))).toEqual(["customer", "not_work_email", "grade", "grade"]);
    for (const outcome of outcomes) expect("suppress" in outcome).toBe(false);
  });

  it("takes the allowed grades from configuration", async () => {
    expect((await reveal({ ...ok, grade: "B" }, { grades: ["A+", "A", "B"] })).kind).toBe("ready");
  });
});
