import { describe, expect, it } from "vitest";

import { LushaBadResponseError, LushaClient, LushaHttpError, LushaNoAnswerError, createLushaClient, recordedLushaFetch } from "@/lib/services/lusha";

/**
 * The Lusha V3 client: one header carries the key and nothing else ever
 * does; a refusal, a timeout, a network failure and an unreadable body each
 * arrive as their own error; and the recorded transport answers from
 * `fixtures/tools/lusha` with no network.
 */

const KEY = "test-key-0123456789abcdef";

type Seen = { url: string; method: string; headers: Record<string, string>; body: string | undefined };

function scripted(answer: (seen: Seen) => Response | Promise<Response>) {
  const seen: Seen[] = [];
  const fetchImpl: typeof globalThis.fetch = async (input, init) => {
    const call = {
      url: String(input),
      method: init?.method ?? "GET",
      headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)),
      body: init?.body === undefined ? undefined : String(init.body),
    };
    seen.push(call);
    return answer(call);
  };
  return { seen, fetchImpl };
}

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

async function thrown(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error("tests: expected a throw");
}

describe("LushaClient", () => {
  it("sends the key in the api_key header to the V3 path, and nowhere else", async () => {
    const { seen, fetchImpl } = scripted(() => json({ credits: { total: 10, used: 1, remaining: 9 } }));
    await new LushaClient(KEY, { fetchImpl }).usage();
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe("https://api.lusha.com/v3/account/usage");
    expect(seen[0]!.headers.api_key).toBe(KEY);
    expect(seen[0]!.url).not.toContain(KEY);
    expect(seen[0]!.body).toBeUndefined();
  });

  it("names the path and the status on a refusal, never the key", async () => {
    for (const status of [400, 401, 403, 429, 500]) {
      const { fetchImpl } = scripted(() => json({ message: `bad key ${KEY}` }, status));
      const error = await thrown(new LushaClient(KEY, { fetchImpl }).sizes());
      expect(error).toBeInstanceOf(LushaHttpError);
      expect((error as LushaHttpError).status).toBe(status);
      expect(error.message).toBe(`lusha: /v3/companies/prospecting/filters/sizes answered ${status}`);
      expect(error.message).not.toContain(KEY);
    }
  });

  it("gives up after its timeout, and says the answer never arrived", async () => {
    const fetchImpl: typeof globalThis.fetch = (_input, init) =>
      new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason)));
    const error = await thrown(new LushaClient(KEY, { fetchImpl, timeoutMs: 20 }).searchContacts({ filters: { contacts: { include: {} } }, pagination: { page: 0, size: 10 } }));
    expect(error).toBeInstanceOf(LushaNoAnswerError);
    expect((error as LushaNoAnswerError).timedOut).toBe(true);
    expect(error.message).not.toContain(KEY);
  });

  it("treats a network failure as no answer, not as a refusal", async () => {
    const fetchImpl: typeof globalThis.fetch = async () => {
      throw new TypeError("fetch failed");
    };
    const error = await thrown(new LushaClient(KEY, { fetchImpl }).countries());
    expect(error).toBeInstanceOf(LushaNoAnswerError);
    expect((error as LushaNoAnswerError).timedOut).toBe(false);
  });

  it("refuses a success whose body is not what Relay reads, including a search with no billing", async () => {
    const notJson = scripted(() => new Response("<html>", { status: 200 }));
    expect(await thrown(new LushaClient(KEY, notJson).usage())).toBeInstanceOf(LushaBadResponseError);
    const noBilling = scripted(() => json({ results: [] }));
    expect(await thrown(new LushaClient(KEY, noBilling).searchContacts({ filters: { contacts: { include: {} } }, pagination: { page: 0, size: 10 } }))).toBeInstanceOf(
      LushaBadResponseError,
    );
  });

  it("posts a search as JSON", async () => {
    const { seen, fetchImpl } = scripted(() => json({ results: [], billing: { creditsCharged: 0, resultsReturned: 0 } }));
    const search = { filters: { contacts: { include: { jobTitles: ["Head of Claims"] } } }, pagination: { page: 0, size: 20 } };
    await new LushaClient(KEY, { fetchImpl }).searchContacts(search);
    expect(seen[0]!.method).toBe("POST");
    expect(seen[0]!.url).toBe("https://api.lusha.com/v3/contacts/prospecting");
    expect(seen[0]!.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(seen[0]!.body!)).toEqual(search);
  });
});

describe("the recorded Lusha transport", () => {
  const client = new LushaClient("recorded", { fetchImpl: recordedLushaFetch() });

  it("answers the metadata the zero-spend check recorded", async () => {
    expect((await client.usage()).pricing?.contactSearch).toEqual({ credits: 1, perQuantity: 25 });
    expect(await client.sizes()).toHaveLength(9);
    expect((await client.sizes()).at(-1)).toEqual({ min: 100001 });
    const industries = await client.industries();
    expect(industries).toHaveLength(17);
    expect(industries.find((main) => main.main_industry === "Finance")?.sub_industries).toContainEqual({ value: "Insurance", id: 44 });
    expect((await client.countries()).find((country) => country.code === "GB")).toEqual({ name: "United Kingdom", code: "GB" });
  });

  it("answers Orkney with South Africa's Orkney, and Orkney Islands with nothing, as the live API did", async () => {
    expect(await client.locations("Orkney")).toEqual([{ continent: "Africa", country: "South Africa", city: "Orkney" }]);
    expect(await client.locations("Orkney Islands")).toEqual([]);
    expect(await client.locations("Nowhere Recorded")).toEqual([]);
  });

  it("answers page 0 from the synthetic page and later pages with nobody", async () => {
    const first = await client.searchContacts({ filters: { contacts: { include: {} } }, pagination: { page: 0, size: 20 } });
    expect(first.results).toHaveLength(14);
    expect(first.billing).toEqual({ creditsCharged: 1, resultsReturned: 14 });
    const next = await client.searchContacts({ filters: { contacts: { include: {} } }, pagination: { page: 1, size: 20 } });
    expect(next.results).toEqual([]);
  });

  it("is what mock mode builds, with no key; live mode without a key is a fault", () => {
    expect(createLushaClient({ INTEGRATIONS: "mock", LUSHA_API_KEY: undefined })).toBeInstanceOf(LushaClient);
    expect(() => createLushaClient({ INTEGRATIONS: "live", LUSHA_API_KEY: undefined })).toThrow(/LUSHA_API_KEY/);
  });
});
