/**
 * The contract mocks (§24: every integration has a mock mode).
 *
 * These are what the rest of Phase 1 develops and tests against, so what they
 * promise matters as much as what the live clients do: deterministic ids, calls
 * recorded in order, and a `reset()` that really does start again.
 */
import { describe, expect, it } from "vitest";

import { MockGraphMailService } from "@/lib/services/graphMail/mock";
import { MockZohoService } from "@/lib/services/zoho/mock";
import type { ConnectedAccountRef } from "@/lib/services/types";

const account: ConnectedAccountRef = {
  id: "acc_1",
  orgId: "org_1",
  userId: "user_1",
  provider: "graph",
  encTokens: "x.y.z",
};

const draft = { to: "a@example.com", subject: "s", body: "b" };

describe("Graph mail mock", () => {
  it("numbers draft, message, internet-message and conversation ids", async () => {
    const graph = new MockGraphMailService();
    const first = await graph.createDraft(account, draft);
    const second = await graph.createDraft(account, { ...draft, to: "b@example.com" });
    expect(first.id).toBe("AAMk-mock-1");
    expect(second.id).toBe("AAMk-mock-2");
    expect(await graph.send(account, second.id)).toEqual({
      id: "AAMk-mock-2",
      internetMessageId: "<mock-2@relay.example>",
      conversationId: "AAQk-mock-conv-2",
    });
    expect(graph.calls).toHaveLength(3);
    graph.reset();
    expect(graph.calls).toEqual([]);
    const afterReset = await graph.createDraft(account, draft);
    expect(afterReset.id).toBe("AAMk-mock-1");
  });

  it("tells a draft from a sent message, and knows what it has never seen", async () => {
    const graph = new MockGraphMailService();
    const created = await graph.createDraft(account, draft);
    await expect(graph.getMessage(account, created.id)).resolves.toMatchObject({
      id: created.id,
      isDraft: true,
    });
    await graph.send(account, created.id);
    await expect(graph.getMessage(account, created.id)).resolves.toMatchObject({
      isDraft: false,
      internetMessageId: "<mock-1@relay.example>",
      conversationId: "AAQk-mock-conv-1",
    });
    await expect(graph.getMessage(account, "AAMk-mock-99")).resolves.toEqual({ notFound: true });
  });

  it("forgets a draft it has been told to throw away", async () => {
    const graph = new MockGraphMailService();
    const created = await graph.createDraft(account, draft);
    await graph.deleteDraft(account, created.id);
    expect(graph.calls.at(-1)).toEqual({ method: "deleteDraft", accountId: account.id, id: created.id });
    await expect(graph.getMessage(account, created.id)).resolves.toEqual({ notFound: true });
  });

  it("refuses to send a draft it never issued, as the live client would", async () => {
    // Graph answers 404 for an unknown message, and `LiveGraphMailService.send`
    // treats that as a hard failure, not sent-but-unverified. A mock that said
    // yes would let Phase 1 build on a state machine the live client refuses.
    const graph = new MockGraphMailService();
    await expect(graph.send(account, "AAMk-mock-99")).rejects.toMatchObject({ status: 404 });
    const created = await graph.createDraft(account, draft);
    await graph.deleteDraft(account, created.id);
    await expect(graph.send(account, created.id)).rejects.toMatchObject({ status: 404 });
  });

  it("lists fixture inbox messages received since the cursor", async () => {
    const graph = new MockGraphMailService();
    const all = await graph.listSince(account, new Date("2026-08-01T00:00:00Z"), ["id", "conversationId"]);
    expect(all).toHaveLength(2);
    const later = await graph.listSince(account, new Date("2026-09-01T10:00:00Z"), ["id"]);
    expect(later).toHaveLength(1);
    expect(later[0]?.subject).toMatch(/Undeliverable/);
  });

  it("returns the inbox it was handed in place of the fixture", async () => {
    const graph = new MockGraphMailService();
    graph.setInbox([{ id: "m1", receivedDateTime: "2026-09-05T09:00:00Z", subject: "Handed in" }]);
    const messages = await graph.listSince(account, new Date("2026-09-01T00:00:00Z"), ["id"]);
    expect(messages.map((m) => m.subject)).toEqual(["Handed in"]);
  });
});

describe("Zoho mock", () => {
  it("upserts by email and records notes and status", async () => {
    const zoho = new MockZohoService();
    const lead = { Email: "priya.raman@brackenmoor.example", Last_Name: "Raman", Company: "Brackenmoor" };
    const created = await zoho.upsertLead(lead);
    const updated = await zoho.upsertLead({ ...lead, First_Name: "Priya" });
    expect(created.created).toBe(true);
    expect(updated).toEqual({ id: created.id, created: false });
    expect(zoho.leads.size).toBe(1);
    expect((await zoho.addNote(created.id, "Marked sent")).id).toMatch(/note/);
    await zoho.setStatus(created.id, "Replied");
    expect(zoho.statuses.get(created.id)).toBe("Replied");
    expect(zoho.calls.map((c) => c.method)).toEqual([
      "upsertLead",
      "upsertLead",
      "addNote",
      "setStatus",
    ]);
    zoho.reset();
    expect(zoho.leads.size).toBe(0);
    expect(zoho.calls).toEqual([]);
  });

  it("returns the Leads field vocabulary from the fixture", async () => {
    const fields = await new MockZohoService().fields("Leads");
    const status = fields.find((f) => f.api_name === "Lead_Status");
    const values = status?.pick_list_values?.map((p) => p.actual_value);
    expect(values).toContain("Meeting Booked");
    // The two the adapters branch on: `findLead` reports `isCustomer` off
    // "Customer", and the opt-out mirror writes "Do Not Contact". A fixture
    // vocabulary without them would make both look like dead code.
    expect(values).toContain("Customer");
    expect(values).toContain("Do Not Contact");
  });

  it("findLead answers null when nothing matches", async () => {
    const zoho = new MockZohoService();
    expect(await zoho.findLead({ email: "nobody@nowhere.example" })).toBeNull();
    expect(await zoho.findLead({ domain: "nowhere.example" })).toBeNull();
  });

  it("findLead matches on email first, then on the company domain, both case-blind", async () => {
    const zoho = new MockZohoService();
    const { id } = await zoho.upsertLead({
      Email: "priya.raman@brackenmoor.example",
      Last_Name: "Raman",
      Company: "Brackenmoor",
      Website: "brackenmoor.example",
    });

    const match = { id, optOut: false, isCustomer: false };
    expect(await zoho.findLead({ email: "PRIYA.RAMAN@brackenmoor.example" })).toEqual(match);
    expect(await zoho.findLead({ domain: "BRACKENMOOR.example" })).toEqual(match);
    expect(zoho.calls.map((c) => c.method)).toEqual(["upsertLead", "findLead", "findLead"]);
  });

  it("updateLead merges fields, and findLead reads the opt-out back", async () => {
    const zoho = new MockZohoService();
    const { id } = await zoho.upsertLead({
      Email: "tom.hale@marlowkent.example",
      Last_Name: "Hale",
      Company: "Marlow & Kent",
    });

    await zoho.updateLead(id, {
      Lead_Status: "Do Not Contact",
      Email_Opt_Out: true,
      Description: "They asked us to stop",
    });

    expect(await zoho.findLead({ email: "tom.hale@marlowkent.example" })).toEqual({
      id,
      optOut: true,
      isCustomer: false,
    });
    expect(zoho.statuses.get(id)).toBe("Do Not Contact");
  });

  it("reports a lead already marked Customer, which is what stops an outbound touch", async () => {
    const zoho = new MockZohoService();
    const { id } = await zoho.upsertLead({
      Email: "ops@halewood.example",
      Last_Name: "Ops",
      Company: "Halewood",
      Lead_Status: "Customer",
    });
    expect(await zoho.findLead({ email: "ops@halewood.example" })).toEqual({
      id,
      optOut: false,
      isCustomer: true,
    });
  });
});
