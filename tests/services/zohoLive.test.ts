/**
 * The live Zoho client, against a fake `fetch`. No network.
 *
 * Zoho's v8 API answers "success" in more than one shape and answers failure
 * inside a 200 as often as beside one, so most of what is asserted here is that
 * the client reads the reply the way Zoho means it.
 */
import { describe, expect, it } from "vitest";

import { LiveZohoService } from "@/lib/services/zoho/live";
import { ServiceError } from "@/lib/services/types";

import { empty, json, stubFetch, testEnv } from "./helpers";

const now = () => new Date("2026-09-02T09:00:00.000Z");
const token = { access_token: "zoho-access-1", expires_in: 3600, api_domain: "https://www.zohoapis.eu" };
const inserted = { data: [{ code: "SUCCESS", action: "insert", status: "success", details: { id: "5566001" } }] };
const lead = { Email: "priya.raman@brackenmoor.example", Last_Name: "Raman", Company: "Brackenmoor Insurance Group" };

function client(responders: Parameters<typeof stubFetch>[0]) {
  const fetchStub = stubFetch(responders);
  const zoho = new LiveZohoService(testEnv(), { fetchImpl: fetchStub.impl, now });
  return { zoho, calls: fetchStub.calls };
}

describe("LiveZohoService — authentication", () => {
  it("fetches a token from the EU data centre before the first call", async () => {
    const { zoho, calls } = client([() => json(token), () => json(inserted)]);

    expect(await zoho.upsertLead(lead)).toEqual({ id: "5566001", created: true });

    expect(calls[0]?.url).toBe("https://accounts.zoho.eu/oauth/v2/token");
    const form = new URLSearchParams(calls[0]?.body ?? "");
    expect(form.get("grant_type")).toBe("refresh_token");
    expect(form.get("refresh_token")).toBe("zoho-refresh");
    expect(form.get("client_id")).toBe("zoho-client");
    expect(calls[1]?.headers.Authorization).toBe("Zoho-oauthtoken zoho-access-1");
  });

  it("caches the access token across calls", async () => {
    const { zoho, calls } = client([() => json(token), () => json(inserted)]);
    await zoho.upsertLead(lead);
    await zoho.upsertLead(lead);
    expect(calls.filter((c) => c.url.includes("accounts.zoho.eu"))).toHaveLength(1);
  });

  it("refreshes once and retries on INVALID_TOKEN inside a 401", async () => {
    const { zoho, calls } = client([
      () => json(token),
      () => json({ code: "INVALID_TOKEN", status: "error" }, 401),
      () => json({ ...token, access_token: "zoho-access-2" }),
      () => json(inserted),
    ]);

    expect(await zoho.upsertLead(lead)).toEqual({ id: "5566001", created: true });
    expect(calls).toHaveLength(4);
    expect(calls[3]?.headers.Authorization).toBe("Zoho-oauthtoken zoho-access-2");
  });

  it("does not retry a write that came back 2xx, whatever the body says", async () => {
    // The retry is gated on `!res.ok` on purpose: an INVALID_TOKEN string inside
    // a 200 body must never cause a second Note to be posted.
    const { zoho, calls } = client([
      () => json(token),
      () => json({ code: "INVALID_TOKEN", data: [{ status: "success", details: { id: "77" } }] }),
    ]);
    expect(await zoho.addNote("5566001", "note")).toEqual({ id: "77" });
    expect(calls).toHaveLength(2);
  });

  it("refuses to build a request when the Zoho credentials are absent", async () => {
    const fetchStub = stubFetch([() => json({})]);
    const zoho = new LiveZohoService(
      { ...testEnv(), RELAY_ZOHO_REFRESH_TOKEN: undefined },
      { fetchImpl: fetchStub.impl, now },
    );
    await expect(zoho.upsertLead(lead)).rejects.toThrow(/RELAY_ZOHO_\*/);
    expect(fetchStub.calls).toHaveLength(0);
  });

  it("makes one token call when concurrent requests race an expired token", async () => {
    // The Zoho token is org-level: every concurrent request in the process
    // shares it, and Zoho caps generations per refresh token per ten minutes.
    const { zoho, calls } = client([
      () => json(token),
      () => json({ data: [{ status: "success", details: { id: "1" } }] }),
    ]);
    await Promise.all([zoho.addNote("1", "a"), zoho.addNote("1", "b"), zoho.addNote("1", "c")]);
    expect(calls.filter((c) => c.url.includes("accounts.zoho.eu"))).toHaveLength(1);
  });

  it("raises when the token endpoint answers 200 with no token", async () => {
    const { zoho } = client([() => json({ expires_in: 3600 })]);
    await expect(zoho.upsertLead(lead)).rejects.toBeInstanceOf(ServiceError);
  });
});

describe("LiveZohoService — the slice-1 write-back", () => {
  it("upserts against Email so a lead the org already has is not duplicated", async () => {
    const { zoho, calls } = client([() => json(token), () => json(inserted)]);
    await zoho.upsertLead(lead);

    const call = calls[1];
    expect(call?.url).toBe("https://www.zohoapis.eu/crm/v8/Leads/upsert");
    expect(call?.method).toBe("POST");
    expect(JSON.parse(call?.body ?? "{}")).toEqual({ data: [lead], duplicate_check_fields: ["Email"] });
  });

  it("reports an update as created:false", async () => {
    const { zoho } = client([
      () => json(token),
      () => json({ data: [{ action: "update", status: "success", details: { id: "5566001" } }] }),
    ]);
    expect(await zoho.upsertLead(lead)).toEqual({ id: "5566001", created: false });
  });

  it("hangs the note off the lead the way v8 wants the parent named", async () => {
    const { zoho, calls } = client([
      () => json(token),
      () => json({ data: [{ status: "success", details: { id: "9900001" } }] }),
    ]);

    expect(await zoho.addNote("5566001", "Marked sent")).toEqual({ id: "9900001" });
    expect(calls[1]?.url).toBe("https://www.zohoapis.eu/crm/v8/Notes");
    expect(JSON.parse(calls[1]?.body ?? "{}")).toEqual({
      data: [
        {
          Note_Title: "Relay",
          Note_Content: "Marked sent",
          // A top-level `se_module` is ignored and the call fails
          // MANDATORY_NOT_FOUND on Parent_Id.module.
          Parent_Id: { module: { api_name: "Leads" }, id: "5566001" },
        },
      ],
    });
  });

  it("writes a status as a single-field update on the lead", async () => {
    const { zoho, calls } = client([() => json(token), () => json({ data: [{ status: "success" }] })]);
    await zoho.setStatus("5566001", "Replied");
    expect(calls[1]?.url).toBe("https://www.zohoapis.eu/crm/v8/Leads/5566001");
    expect(calls[1]?.method).toBe("PUT");
    expect(JSON.parse(calls[1]?.body ?? "{}")).toEqual({ data: [{ Lead_Status: "Replied" }] });
  });

  it("mirrors an opt-out as a field merge", async () => {
    const { zoho, calls } = client([() => json(token), () => json({ data: [{ status: "success" }] })]);
    await zoho.updateLead("5566001", { Email_Opt_Out: true, Lead_Status: "Do Not Contact" });
    expect(JSON.parse(calls[1]?.body ?? "{}")).toEqual({
      data: [{ Email_Opt_Out: true, Lead_Status: "Do Not Contact" }],
    });
  });

  it("percent-encodes the lead id into the path", async () => {
    const { zoho, calls } = client([() => json(token), () => json({ data: [{ status: "success" }] })]);
    await zoho.setStatus("55/66 001", "Replied");
    expect(calls[1]?.url).toBe("https://www.zohoapis.eu/crm/v8/Leads/55%2F66%20001");
  });

  it("raises rather than reporting an id when a 2xx carries no record id", async () => {
    const { zoho } = client([() => json(token), () => json({ data: [{ status: "success" }] })]);
    await expect(zoho.upsertLead(lead)).rejects.toMatchObject({ code: "malformed_response" });
  });

  it("raises on a row-level error inside a 200", async () => {
    // Zoho reports a per-record failure with a 200 and `status: "error"` on the
    // row. Read as a success, that is a lead nobody wrote and nobody noticed.
    const { zoho } = client([
      () => json(token),
      () => json({ data: [{ status: "error", code: "MANDATORY_NOT_FOUND" }] }),
    ]);
    const error = await zoho.upsertLead(lead).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ServiceError);
    expect(error).toMatchObject({ service: "zoho", code: "MANDATORY_NOT_FOUND" });
  });
});

describe("LiveZohoService — reading the CRM", () => {
  it("looks a lead up by email first", async () => {
    const { zoho, calls } = client([
      () => json(token),
      () => json({ data: [{ id: "5566001", Email_Opt_Out: false, Lead_Status: "Contacted" }] }),
    ]);

    expect(await zoho.findLead({ email: "priya.raman@brackenmoor.example", domain: "brackenmoor.example" })).toEqual({
      id: "5566001",
      optOut: false,
      isCustomer: false,
    });
    // The domain search is not made: the email matched.
    expect(calls).toHaveLength(2);
    expect(calls[1]?.url).toBe(
      "https://www.zohoapis.eu/crm/v8/Leads/search?email=priya.raman%40brackenmoor.example",
    );
  });

  it("falls back to the company website when no lead has that address", async () => {
    const { zoho, calls } = client([
      () => json(token),
      () => empty(204),
      () => json({ data: [{ id: "5566002", Email_Opt_Out: true, Lead_Status: "Customer" }] }),
    ]);

    expect(await zoho.findLead({ email: "new@brackenmoor.example", domain: "brackenmoor.example" })).toEqual({
      id: "5566002",
      optOut: true,
      isCustomer: true,
    });
    expect(calls[2]?.url).toBe(
      `https://www.zohoapis.eu/crm/v8/Leads/search?criteria=${encodeURIComponent("(Website:equals:brackenmoor.example)")}`,
    );
  });

  it("reads a 204 with no body as 'no such lead', not as an error", async () => {
    // Zoho answers a search that found nothing with 204 and nothing at all.
    const { zoho } = client([() => json(token), () => empty(204)]);
    expect(await zoho.findLead({ email: "nobody@nowhere.example" })).toBeNull();
  });

  it("returns the Leads field vocabulary", async () => {
    const { zoho, calls } = client([
      () => json(token),
      () => json({ fields: [{ api_name: "Lead_Status", data_type: "picklist" }] }),
    ]);
    expect(await zoho.fields("Leads")).toEqual([{ api_name: "Lead_Status", data_type: "picklist" }]);
    expect(calls[1]?.url).toBe("https://www.zohoapis.eu/crm/v8/settings/fields?module=Leads");
  });

  it("names a row-level error code reported beside a 4xx", async () => {
    // Zoho puts the code on the record as often as at the top level. Read only
    // at the top level, the code came back undefined for the commonest failure.
    const { zoho } = client([
      () => json(token),
      () => json({ data: [{ code: "DUPLICATE_DATA", status: "error" }] }, 400),
    ]);
    await expect(zoho.upsertLead(lead)).rejects.toMatchObject({ code: "DUPLICATE_DATA" });
  });

  it("does not put a domain that is not a hostname into the criteria grammar", async () => {
    // `criteria` is a grammar: a value carrying `(`, `)` or `:` makes a
    // malformed expression and a 400 where "no match" is the truthful answer.
    const { zoho, calls } = client([() => json(token), () => empty(204)]);
    expect(await zoho.findLead({ domain: "brackenmoor.example) or (Email:equals:a@b.c" })).toBeNull();
    expect(calls.filter((c) => c.url.includes("/search"))).toHaveLength(0);
  });

  it("names the error without quoting Zoho's response body", async () => {
    const { zoho } = client([
      () => json(token),
      () => json({ code: "INVALID_DATA", message: "secret internal detail" }, 400),
    ]);
    const error = await zoho.upsertLead(lead).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ServiceError);
    expect((error as ServiceError).message).not.toContain("secret internal detail");
    expect((error as ServiceError).code).toBe("INVALID_DATA");
  });
});

describe("LiveZohoService — the domain a criteria search will accept", () => {
  it("refuses a label longer than a hostname label may be", async () => {
    // 63 octets is the DNS limit. Anything longer is not a hostname, so it is
    // not something to build a criteria expression out of and send to Zoho.
    const { zoho, calls } = client([() => json(token), () => empty(204)]);

    expect(await zoho.findLead({ domain: `${"a".repeat(64)}.example` })).toBeNull();

    expect(calls.filter((c) => c.url.includes("/Leads/search"))).toHaveLength(0);
  });

  it("refuses a name longer than a domain name may be", async () => {
    const { zoho, calls } = client([() => json(token), () => empty(204)]);
    const tooLong = `${Array.from({ length: 60 }, () => "abcd").join(".")}.example`;

    expect(tooLong.length).toBeGreaterThan(253);
    expect(await zoho.findLead({ domain: tooLong })).toBeNull();

    expect(calls.filter((c) => c.url.includes("/Leads/search"))).toHaveLength(0);
  });

  it("answers a pathological non-hostname promptly rather than backtracking over it", async () => {
    // The bound, not the shape, is what makes this safe to say: the pattern is
    // anchored at both ends and every quantifier inside it is counted, and the
    // value is rejected on length before the matcher is asked at all.
    const { zoho } = client([() => json(token), () => empty(204)]);
    const pathological = `${"a".repeat(20_000)}${"-".repeat(20_000)}`;

    const started = performance.now();
    expect(await zoho.findLead({ domain: pathological })).toBeNull();
    expect(performance.now() - started).toBeLessThan(50);
  });

  it("still searches on an ordinary hostname", async () => {
    const { zoho, calls } = client([
      () => json(token),
      () => json({ data: [{ id: "5566001", Lead_Status: "Contacted" }] }),
    ]);

    expect(await zoho.findLead({ domain: "sub.brackenmoor.example" })).toEqual({
      id: "5566001",
      optOut: false,
      isCustomer: false,
    });
    expect(calls[1]?.url).toContain(encodeURIComponent("(Website:equals:sub.brackenmoor.example)"));
  });
});

describe("LiveZohoService — the smoke-probe delete is gated at runtime", () => {
  function gated(overrides: Record<string, string>) {
    const fetchStub = stubFetch([() => json(token), () => empty(200)]);
    const zoho = new LiveZohoService(testEnv(overrides), { fetchImpl: fetchStub.impl, now });
    return { zoho, calls: fetchStub.calls };
  }

  it("refuses to delete unless the live-test switch is on", async () => {
    const { zoho, calls } = gated({ NODE_ENV: "test" });

    await expect(zoho.removeLeadForSmokeTest("5566001")).rejects.toThrow(/RELAY_LIVE_TESTS/);

    expect(calls).toHaveLength(0);
  });

  it("refuses to delete in production even with the switch on", async () => {
    const { zoho, calls } = gated({ NODE_ENV: "production", RELAY_LIVE_TESTS: "1" });

    await expect(zoho.removeLeadForSmokeTest("5566001")).rejects.toThrow(/production/);

    expect(calls).toHaveLength(0);
  });

  it("deletes when the switch is on outside production", async () => {
    const { zoho, calls } = gated({ NODE_ENV: "test", RELAY_LIVE_TESTS: "1" });

    await zoho.removeLeadForSmokeTest("5566001");

    expect(calls[1]?.method).toBe("DELETE");
    expect(calls[1]?.url).toBe("https://www.zohoapis.eu/crm/v8/Leads/5566001");
  });
});
