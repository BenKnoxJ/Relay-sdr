import fieldsFixture from "../../../../fixtures/integrations/zoho-fields.json";
import type {
  ZohoField,
  ZohoLeadFields,
  ZohoLeadInput,
  ZohoLeadMatch,
  ZohoService,
} from "../types";

export type ZohoMockCall =
  | { method: "fields"; module: "Leads" }
  | { method: "upsertLead"; lead: ZohoLeadInput }
  | { method: "addNote"; leadId: string; note: string }
  | { method: "setStatus"; leadId: string; status: string }
  | { method: "findLead"; query: { email?: string; domain?: string } }
  | { method: "updateLead"; id: string; fields: ZohoLeadFields };

/** Deterministic contract mock: leads live in an in-memory map keyed by email. */
export class MockZohoService implements ZohoService {
  readonly calls: ZohoMockCall[] = [];
  readonly leads = new Map<string, ZohoLeadInput & { id: string }>();
  readonly statuses = new Map<string, string>();
  private n = 0;

  reset(): void {
    this.calls.length = 0;
    this.leads.clear();
    this.statuses.clear();
    this.n = 0;
  }

  async fields(module: "Leads"): Promise<ZohoField[]> {
    this.calls.push({ method: "fields", module });
    return fieldsFixture.fields as ZohoField[];
  }

  async upsertLead(lead: ZohoLeadInput) {
    this.calls.push({ method: "upsertLead", lead });
    const key = lead.Email.toLowerCase();
    const existing = this.leads.get(key);
    if (existing) {
      this.leads.set(key, { ...existing, ...lead, id: existing.id });
      return { id: existing.id, created: false };
    }
    const id = this.nextId("lead");
    this.leads.set(key, { ...lead, id });
    return { id, created: true };
  }

  async addNote(leadId: string, note: string) {
    this.calls.push({ method: "addNote", leadId, note });
    return { id: this.nextId("note") };
  }

  async setStatus(leadId: string, status: string) {
    this.calls.push({ method: "setStatus", leadId, status });
    this.statuses.set(leadId, status);
  }

  async findLead(query: { email?: string; domain?: string }): Promise<ZohoLeadMatch | null> {
    this.calls.push({ method: "findLead", query });
    const byEmail = query.email ? this.leads.get(query.email.toLowerCase()) : undefined;
    const domain = query.domain?.toLowerCase();
    const found =
      byEmail ??
      (domain
        ? [...this.leads.values()].find((lead) => String(lead.Website ?? "").toLowerCase() === domain)
        : undefined);
    if (!found) return null;
    return {
      id: found.id,
      optOut: found.Email_Opt_Out === true,
      isCustomer: String(found.Lead_Status ?? "") === "Customer",
    };
  }

  async updateLead(id: string, fields: ZohoLeadFields): Promise<void> {
    this.calls.push({ method: "updateLead", id, fields });
    for (const [key, lead] of this.leads) {
      if (lead.id === id) this.leads.set(key, { ...lead, ...fields, id });
    }
    if (typeof fields.Lead_Status === "string") this.statuses.set(id, fields.Lead_Status);
  }

  private nextId(kind: string): string {
    this.n += 1;
    return `zcrm_mock_${kind}_${this.n}`;
  }
}
