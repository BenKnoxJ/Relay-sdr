import { describe, expect, it } from "vitest";

import { LushaRevealer, lushaRevealed } from "@/lib/leadgen/lusha";
import { ProviderBusyError, ProviderNotSentError, ProviderUnknownOutcomeError } from "@/lib/leadgen/provider";
import { LushaClient, recordedLushaFetch } from "@/lib/services/lusha";

/**
 * Reveal emails over Lusha V3 enrich, as the published `enrichContacts`
 * contract describes it: `ids` and `reveal: ["emails"]` and nothing about
 * phones, the answer mapped into Relay's own words, and the recorded
 * transport answering from `fixtures/tools/lusha/enrich`. No network.
 */

const KEY = ["not", "a", "real", "lusha", "key"].join("-");

function scripted(answer: () => Response | Promise<Response>) {
  const seen: { url: string; method: string; body: unknown }[] = [];
  const fetchImpl: typeof globalThis.fetch = async (input, init) => {
    seen.push({ url: String(input), method: init?.method ?? "GET", body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) });
    return answer();
  };
  return { seen, fetchImpl };
}

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

const ANSWER = {
  requestId: "r-1",
  results: [
    {
      id: "c-1",
      firstName: "Avery",
      lastName: "Dunmore",
      fullName: "Avery J Dunmore",
      company: { id: "9", name: "Ardent", domain: "www.ardent.example" },
      emails: [
        { email: "Avery.Dunmore@Ardent.example", type: "work", confidence: "A+" },
        { email: "avery@mail.example", type: "private", confidence: "A" },
      ],
      phones: [{ number: "+440000000000", type: "mobile" }],
    },
    { id: "c-2", error: { code: "NOT_FOUND", message: "Contact not found" } },
  ],
  billing: { creditsCharged: 1, resultsReturned: 1 },
};

describe("the enrich request", () => {
  it("@proof asks for emails only, with the waterfall off, for the ids given, at the published path", async () => {
    const { seen, fetchImpl } = scripted(() => json(ANSWER));
    await new LushaClient(KEY, { fetchImpl }).enrichEmails(["c-1", "c-2"]);
    expect(seen).toEqual([{ url: "https://api.lusha.com/v3/contacts/enrich", method: "POST", body: { ids: ["c-1", "c-2"], reveal: ["emails"], waterfallEnabled: false } }]);
  });

  it("refuses to send no ids or more than a hundred", async () => {
    const { seen, fetchImpl } = scripted(() => json(ANSWER));
    const client = new LushaClient(KEY, { fetchImpl });
    expect(() => client.enrichEmails([])).toThrow();
    expect(() => client.enrichEmails(Array.from({ length: 101 }, (_, index) => `c-${index}`))).toThrow();
    expect(seen).toHaveLength(0);
  });

  it("@proof never carries a phone number into Relay, even when the answer holds one", async () => {
    const { fetchImpl } = scripted(() => json(ANSWER));
    const page = await new LushaClient(KEY, { fetchImpl }).enrichEmails(["c-1"]);
    expect(JSON.stringify(page)).not.toContain("+440000000000");
    expect(JSON.stringify(page)).not.toContain("phones");
  });
});

describe("the answer in Relay's words", () => {
  it("maps names as the preview built them, the email lower case, private as personal, and a per-item error as a reason", () => {
    expect(lushaRevealed(ANSWER.results[0] as never)).toEqual({
      status: "found",
      name: "Avery Dunmore",
      domain: "www.ardent.example",
      emails: [
        { address: "avery.dunmore@ardent.example", type: "work", grade: "A+" },
        { address: "avery@mail.example", type: "personal", grade: "A" },
      ],
    });
    expect(lushaRevealed({ id: "x", error: { code: "NOT_FOUND", message: null } } as never)).toEqual({ status: "not_found" });
    expect(lushaRevealed({ id: "x", error: { code: "COMPLIANCE_RESTRICTED", message: null } } as never)).toEqual({ status: "restricted" });
    expect(lushaRevealed({ id: "x", error: { code: "ENRICH_FAILED", message: null } } as never)).toEqual({ status: "failed" });
    expect(lushaRevealed({ id: "x", emails: [{ email: "not an email", type: "work", confidence: "A" }] } as never)).toMatchObject({ status: "found", emails: [] });
  });

  it("@proof returns only the ids asked about, and what the provider charged", async () => {
    const { fetchImpl } = scripted(() => json({ ...ANSWER, results: [...ANSWER.results, { id: "not-asked", emails: [{ email: "x@y.example", type: "work" }] }] }));
    const answer = await new LushaRevealer(new LushaClient(KEY, { fetchImpl })).revealEmails({ key: "k", providerIds: ["c-1", "c-2"] });
    expect([...answer.contacts.keys()]).toEqual(["c-1", "c-2"]);
    expect(answer.charged).toBe(1);
  });

  it("@proof tells a request that never left Relay from one that may have been sent", async () => {
    const refused = Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    const cases: [typeof globalThis.fetch, unknown][] = [
      [async () => Promise.reject(refused), ProviderNotSentError],
      [async () => Promise.reject(Object.assign(new Error("timed out"), { name: "TimeoutError" })), ProviderUnknownOutcomeError],
      [async () => json({ message: "slow down" }, 429), ProviderBusyError],
      [async () => json({ message: "down" }, 503), ProviderUnknownOutcomeError],
    ];
    for (const [fetchImpl, kind] of cases) {
      await expect(new LushaRevealer(new LushaClient(KEY, { fetchImpl })).revealEmails({ key: "k", providerIds: ["c-1"] })).rejects.toBeInstanceOf(kind as never);
    }
  });
});

describe("the recorded transport", () => {
  it("answers from the recording: emails, one without, one not found, and one already revealed for free", async () => {
    const answer = await new LushaRevealer(new LushaClient("recorded", { fetchImpl: recordedLushaFetch() })).revealEmails({
      key: "k",
      providerIds: ["v22-a01", "v22-a04", "v22-a05", "v22-a08", "never-recorded"],
    });
    expect(answer.contacts.get("v22-a01")).toMatchObject({ status: "found", name: "Avery Dunmore", emails: [{ address: "avery.dunmore@ardent-motor.example", type: "work" }] });
    expect(answer.contacts.get("v22-a04")).toMatchObject({ status: "found", emails: [] });
    expect(answer.contacts.get("v22-a08")).toEqual({ status: "not_found" });
    expect(answer.contacts.get("never-recorded")).toEqual({ status: "not_found" });
    // a01 is charged; a05 was revealed before and is free; nothing is charged without an email.
    expect(answer.charged).toBe(1);
  });

  it("@proof refuses a request that asks for phones", async () => {
    const response = await recordedLushaFetch()("https://api.lusha.com/v3/contacts/enrich", { method: "POST", body: JSON.stringify({ ids: ["v22-a01"], reveal: ["emails", "phones"] }) });
    expect(response.status).toBe(400);
  });
});
