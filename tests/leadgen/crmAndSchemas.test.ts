import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { leadGenHandoffV1Schema } from "../../agents/leadgen/input.schema";
import { haltSchema, leadgenOutputSchema } from "../../agents/leadgen/output.schema";
import { zohoCrmCheck } from "@/lib/leadgen/crm";
import type { ZohoLeadMatch } from "@/lib/services/types";

import { handoff } from "./harness";

/** The CRM check over today's Zoho adapter, and the v2.1 schema rules. */

function zoho(answers: Record<string, ZohoLeadMatch | null>) {
  const asked: { email?: string; domain?: string }[] = [];
  return {
    asked,
    async findLead(query: { email?: string; domain?: string }) {
      asked.push(query);
      return answers[query.email ?? query.domain ?? ""] ?? null;
    },
  };
}

describe("zohoCrmCheck", () => {
  it("holds on a positive Customer answer only; a miss or a non-customer proves nothing", async () => {
    const check = zohoCrmCheck(
      zoho({
        "customer.example": { id: "1", optOut: false, isCustomer: true },
        "lead.example": { id: "2", optOut: false, isCustomer: false },
      }),
    );
    expect(await check.isCustomerDomain("customer.example")).toBe(true);
    expect(await check.isCustomerDomain("lead.example")).toBe(false);
    expect(await check.isCustomerDomain("unknown.example")).toBe(false);
  });

  it("asks by domain for a company and by email for a person, never both at once", async () => {
    const fake = zoho({ "a@b.example": { id: "3", optOut: true, isCustomer: false } });
    const check = zohoCrmCheck(fake);
    expect(await check.emailStatus("a@b.example")).toEqual({ optOut: true, isCustomer: false });
    await check.isCustomerDomain("b.example");
    expect(fake.asked).toEqual([{ email: "a@b.example" }, { domain: "b.example" }]);
  });
});

describe("LeadGenHandoffV1", () => {
  it("accepts the fixture handoff and the harness handoff", () => {
    const fixture: unknown = JSON.parse(readFileSync(path.resolve(import.meta.dirname, "../../agents/leadgen/fixtures/input.good.json"), "utf8"));
    expect(leadGenHandoffV1Schema.safeParse(fixture).success).toBe(true);
    expect(leadGenHandoffV1Schema.safeParse(handoff()).success).toBe(true);
  });

  it("refuses a cap above the balance, a count Start never offers, and anything extra", () => {
    expect(leadGenHandoffV1Schema.safeParse(handoff((h) => (h.spend.searchCreditCap = 101))).success).toBe(false);
    expect(leadGenHandoffV1Schema.safeParse({ ...handoff(), howMany: 15 }).success).toBe(false);
    expect(leadGenHandoffV1Schema.safeParse({ ...handoff(), holds: {} }).success).toBe(false);
  });
});

describe("the output schema", () => {
  const good: unknown = JSON.parse(readFileSync(path.resolve(import.meta.dirname, "../../agents/leadgen/fixtures/output.good.json"), "utf8"));
  const pick = good as Record<string, unknown> & { found: { n: number; ofM: number } };

  it("gives a shortfall exactly when fewer were found than asked for", () => {
    expect(leadgenOutputSchema.safeParse(pick).success).toBe(true);
    const without = Object.fromEntries(Object.entries(pick).filter(([key]) => key !== "shortfall"));
    expect(leadgenOutputSchema.safeParse(without).success).toBe(false);
  });

  it("no longer knows v2's open-deal hold or re-attach ledger", () => {
    expect(leadgenOutputSchema.safeParse({ ...pick, holdsApplied: [{ reason: "open_deal", count: 1 }] }).success).toBe(false);
    expect(
      leadgenOutputSchema.safeParse({ phase: "revealed", people: [], ledger: [{ lushaId: "l-1", credits: 1, reattached: true }], held: [] }).success,
    ).toBe(false);
  });

  it("offers a rep at most three choices, as words", () => {
    const spend = { searchCreditCap: 40, charged: 0, reserved: 0, pricingAssumptions: "x", exceededDocumentedWorstCase: false };
    expect(haltSchema.safeParse({ phase: "needs_you", reason: "choose_industry", term: "t", choices: ["a", "b", "c"], spend }).success).toBe(true);
    expect(haltSchema.safeParse({ phase: "needs_you", reason: "choose_industry", term: "t", choices: ["a", "b", "c", "d"], spend }).success).toBe(false);
  });
});
