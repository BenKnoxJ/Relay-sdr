import type { Env } from "@/lib/env";

import {
  ServiceError,
  type LiveDeps,
  type ZohoField,
  type ZohoLeadFields,
  type ZohoLeadInput,
  type ZohoLeadMatch,
  type ZohoService,
} from "../types";

// EU data centre (confirmed by the Sales360 Wave-1 probe against the live org).
//
// Hard-coded rather than read from `ZOHO_CRM_BASE_URL`: that variable holds the
// org's CRM *web* address (`https://crm.zoho.eu/crm/org12345`), which is what a
// link in a screen needs and is not an API origin. A US or IN org would need
// `zohoapis.com`/`.in` here and its own accounts host; there is one org and it
// is in the EU, so that is a Phase-2 problem and not a guess made now.
const ACCOUNTS_BASE = "https://accounts.zoho.eu";
const API_BASE = "https://www.zohoapis.eu/crm/v8";
/**
 * A plain hostname, which is all `findLead`'s criteria search may interpolate.
 *
 * Anchored at both ends and every quantifier counted: a label is 1–63 octets
 * (the DNS limit), so there is no unbounded repetition for a pathological value
 * to backtrack through. `MAX_HOSTNAME` rejects an over-long value before the
 * matcher is asked at all — the input reaching here is a website field off an
 * enriched record, and nothing upstream promises it is short.
 */
const HOSTNAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;
/** A domain name is at most 253 octets once the root's trailing dot is dropped. */
const MAX_HOSTNAME = 253;
const TIMEOUT_MS = 20_000;
const EXPIRY_SKEW_MS = 60_000;

type Json = Record<string, unknown>;

type ZohoEnv = Pick<
  Env,
  | "RELAY_ZOHO_CLIENT_ID"
  | "RELAY_ZOHO_CLIENT_SECRET"
  | "RELAY_ZOHO_REFRESH_TOKEN"
  // Read by `removeLeadForSmokeTest`'s gate. Taken by injection like the rest,
  // so the one destructive call in this file is a function of the environment
  // the client was handed and can be tested without mutating `process.env`.
  | "RELAY_LIVE_TESTS"
  | "NODE_ENV"
>;

/**
 * Live Zoho CRM v8 client. The access token is cached in memory until expiry and
 * refreshed once on `INVALID_TOKEN`/401.
 *
 * One token per process, not per org: Relay's Zoho credentials are org-level
 * (§19, "org"), and the pilot is one org. A second tenant means a keyed cache
 * and credentials off the ConnectedAccount rather than off the environment —
 * flagged here because this class is where that change lands.
 */
export class LiveZohoService implements ZohoService {
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly now: () => Date;
  private token?: { accessToken: string; expiresAt: number };
  /** A refresh already in flight, so concurrent callers make one token call. */
  private refreshing?: Promise<string>;

  constructor(
    private readonly env: ZohoEnv,
    deps: LiveDeps = {},
  ) {
    this.fetchImpl = deps.fetchImpl ?? globalThis.fetch;
    this.now = deps.now ?? (() => new Date());
  }

  async fields(module: "Leads"): Promise<ZohoField[]> {
    const json = await this.request("GET", `/settings/fields?module=${encodeURIComponent(module)}`);
    return Array.isArray(json.fields) ? (json.fields as ZohoField[]) : [];
  }

  async upsertLead(lead: ZohoLeadInput) {
    const json = await this.request("POST", "/Leads/upsert", {
      data: [lead],
      duplicate_check_fields: ["Email"],
    });
    const row = firstRow(json);
    return { id: requireId(json), created: str(row.action) === "insert" };
  }

  async addNote(leadId: string, note: string) {
    const json = await this.request("POST", "/Notes", {
      data: [
        {
          Note_Title: "Relay",
          Note_Content: note,
          // v8 wants the parent module inside Parent_Id; a top-level se_module is
          // ignored and the call fails MANDATORY_NOT_FOUND on Parent_Id.module.
          Parent_Id: { module: { api_name: "Leads" }, id: leadId },
        },
      ],
    });
    return { id: requireId(json) };
  }

  async setStatus(leadId: string, status: string): Promise<void> {
    await this.request("PUT", `/Leads/${encodeURIComponent(leadId)}`, { data: [{ Lead_Status: status }] });
  }

  async findLead(query: { email?: string; domain?: string }): Promise<ZohoLeadMatch | null> {
    if (query.email) {
      const byEmail = await this.searchLeads(`/Leads/search?email=${encodeURIComponent(query.email)}`);
      if (byEmail) return byEmail;
    }
    // Zoho's `criteria` is a grammar, not a query string: `encodeURIComponent`
    // makes the value transport-safe but a domain carrying `(`, `)`, `:` or a
    // space still produces a malformed expression and a 400 — turning "this
    // enriched record has a junk website field" into an adapter error. A domain
    // that is not a plain hostname simply does not match anything.
    if (query.domain && query.domain.length <= MAX_HOSTNAME && HOSTNAME.test(query.domain)) {
      const criteria = `(Website:equals:${query.domain})`;
      const byDomain = await this.searchLeads(`/Leads/search?criteria=${encodeURIComponent(criteria)}`);
      if (byDomain) return byDomain;
    }
    return null;
  }

  async updateLead(id: string, fields: ZohoLeadFields): Promise<void> {
    await this.request("PUT", `/Leads/${encodeURIComponent(id)}`, { data: [fields] });
  }

  /** A search that found nothing answers 204 with no body, which is not an error. */
  private async searchLeads(path: string): Promise<ZohoLeadMatch | null> {
    const json = await this.request("GET", path);
    const row = firstRow(json);
    const id = str(row.id);
    if (!id) return null;
    return {
      id,
      optOut: row.Email_Opt_Out === true,
      isCustomer: str(row.Lead_Status) === "Customer",
    };
  }

  /**
   * Permanently remove a lead.
   *
   * Deliberately NOT on `ZohoService`: nothing Relay ships deletes a record out
   * of a customer's CRM (§25, rule 1). It exists because the opt-in live smoke
   * probe creates a real lead in a real org and has to clean up after itself,
   * and reaching it requires naming `LiveZohoService` rather than the interface
   * — which is exactly the friction that should stand between application code
   * and this call.
   *
   * The runtime gate below is the half of that friction a rename cannot undo.
   * Naming discipline is a convention, and a convention is one refactor away
   * from being gone; this is the only call Relay makes that destroys a record
   * in a customer's CRM, so it is worth a check that survives the refactor.
   */
  async removeLeadForSmokeTest(id: string): Promise<void> {
    if (this.env.RELAY_LIVE_TESTS !== "1" || this.env.NODE_ENV === "production") {
      throw new Error(
        "removeLeadForSmokeTest is the live smoke probe's own cleanup: it runs only when " +
          'RELAY_LIVE_TESTS="1" and NODE_ENV is not "production"',
      );
    }
    await this.request("DELETE", `/Leads/${encodeURIComponent(id)}`);
  }

  // ------------------------------------------------------------- internals

  private async request(method: "GET" | "POST" | "PUT" | "DELETE", path: string, body?: Json): Promise<Json> {
    let token = await this.accessToken();
    let res = await this.call(method, path, token, body);
    let json = await readJson(res);
    if (!res.ok && (res.status === 401 || str(json.code) === "INVALID_TOKEN")) {
      // One refresh-and-retry. Gated on !res.ok so a 2xx body never causes a
      // Note or a status write to be posted twice.
      token = await this.refresh();
      res = await this.call(method, path, token, body);
      json = await readJson(res);
    }
    if (!res.ok) {
      // Zoho reports a per-record failure as `{"data":[{"code":"…","status":"error"}]}`
      // beside the 4xx as often as it reports a top-level `code`. Reading only
      // the top level left `ServiceError.code` undefined for exactly the errors
      // an operator most needs named.
      throw new ServiceError({
        service: "zoho",
        status: res.status,
        code: str(json.code) || str(firstRow(json).code) || undefined,
      });
    }
    const row = firstRow(json);
    if (row.status === "error") {
      throw new ServiceError({ service: "zoho", status: res.status, code: str(row.code) || undefined });
    }
    return json;
  }

  private call(method: "GET" | "POST" | "PUT" | "DELETE", path: string, token: string, body?: Json): Promise<Response> {
    return this.fetchImpl(`${API_BASE}${path}`, {
      method,
      headers: {
        Authorization: `Zoho-oauthtoken ${token}`,
        "Content-Type": "application/json",
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  }

  private async accessToken(): Promise<string> {
    const cached = this.token;
    if (cached && cached.expiresAt - EXPIRY_SKEW_MS > this.now().getTime()) return cached.accessToken;
    return this.refresh();
  }

  /**
   * One token call at a time. Zoho caps access-token generations per refresh
   * token per ten minutes, and this token is org-level — every concurrent
   * request in the process piles onto the same limit. Without this fence a
   * burst of jobs at expiry spends the quota on itself.
   */
  private async refresh(): Promise<string> {
    if (this.refreshing) return this.refreshing;
    const started = this.doRefresh().finally(() => {
      this.refreshing = undefined;
    });
    this.refreshing = started;
    return started;
  }

  private async doRefresh(): Promise<string> {
    const {
      RELAY_ZOHO_CLIENT_ID: clientId,
      RELAY_ZOHO_CLIENT_SECRET: clientSecret,
      RELAY_ZOHO_REFRESH_TOKEN: refreshToken,
    } = this.env;
    if (!clientId || !clientSecret || !refreshToken) {
      throw new Error("RELAY_ZOHO_* env is required for the live Zoho client");
    }
    const res = await this.fetchImpl(`${ACCOUNTS_BASE}/oauth/v2/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        refresh_token: refreshToken,
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: "refresh_token",
      }).toString(),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const json = await readJson(res);
    const accessToken = str(json.access_token);
    if (!res.ok || !accessToken) {
      throw new ServiceError({ service: "zoho", status: res.status, code: str(json.error) || undefined });
    }
    const expiresIn = typeof json.expires_in === "number" ? json.expires_in : 3600;
    this.token = { accessToken, expiresAt: this.now().getTime() + expiresIn * 1000 };
    return accessToken;
  }
}

async function readJson(res: Response): Promise<Json> {
  const text = await res.text();
  if (!text) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === "object" ? (parsed as Json) : {};
  } catch {
    return {};
  }
}

/** A 2xx with no record id is a contract violation, not a silent empty write. */
function requireId(json: Json): string {
  const id = str((firstRow(json).details as Json | undefined)?.id);
  if (!id) throw new ServiceError({ service: "zoho", status: 200, code: "malformed_response" });
  return id;
}

function firstRow(json: Json): Json {
  const data = json.data;
  return Array.isArray(data) && data[0] && typeof data[0] === "object" ? (data[0] as Json) : {};
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}
