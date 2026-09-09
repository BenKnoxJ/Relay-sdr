import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { COUNTRY_NAMES, countryName, createFirecrawlService, createTavilyService, fetchDiscriminator, searchDiscriminator, timeRange } from "@/lib/services";
import { recordingPath } from "@/lib/services/research/recordings";
import { ServiceError } from "@/lib/services/types";

/**
 * The research tools' providers: the wire shapes read off the fleet's MCP
 * servers, the mock's honest misses, and the record → replay loop.
 */

const dir = mkdtempSync(path.join(tmpdir(), "relay-tool-fixtures-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const ENV = { TAVILY_API_KEY: "tvly_test", FIRECRAWL_API_KEY: "fc_test" };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("the Tavily adapter", () => {
  it("maps the region to a country name and the recency to Tavily's time_range", () => {
    expect(countryName("gb")).toBe("united kingdom");
    expect(() => countryName("XX")).toThrow(ServiceError);
    expect(Object.keys(COUNTRY_NAMES)).toContain("IE");
    expect(timeRange(undefined)).toBeUndefined();
    expect(timeRange(1)).toBe("month");
    expect(timeRange(12)).toBe("year");
    expect(timeRange(24)).toBeUndefined();
  });

  it("sends the documented request and returns hits with dates as ISO dates", async () => {
    let seen: { url: string; body: unknown; auth: string | null } | undefined;
    const service = createTavilyService(ENV, {
      mode: "live",
      fixturesDir: dir,
      fetchImpl: async (url, init) => {
        seen = { url: String(url), body: JSON.parse(String(init?.body)), auth: new Headers(init?.headers).get("authorization") };
        return jsonResponse({
          results: [
            { title: "A", url: "https://a.example/1", content: "snippet a", published_date: "Tue, 03 Mar 2026 10:00:00 GMT" },
            { title: "B", url: "https://b.example/2", content: "snippet b" },
            { url: "" },
          ],
        });
      },
    });
    const { hits } = await service.search({ query: "claims backlog UK insurers", region: "GB", recencyMonths: 12 });
    expect(seen?.url).toBe("https://api.tavily.com/search");
    expect(seen?.auth).toBe("Bearer tvly_test");
    expect(seen?.body).toMatchObject({ query: "claims backlog UK insurers", country: "united kingdom", time_range: "year", max_results: 8, search_depth: "basic" });
    expect(JSON.stringify(seen?.body)).not.toContain("api_key");
    expect(hits).toEqual([
      { title: "A", url: "https://a.example/1", snippet: "snippet a", publishedAt: "2026-03-03" },
      { title: "B", url: "https://b.example/2", snippet: "snippet b" },
    ]);
  });

  it("returns an extract as a page, and a failure as unreadable rather than a throw", async () => {
    const service = createTavilyService(ENV, {
      mode: "live",
      fixturesDir: dir,
      fetchImpl: async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as { urls: string[] };
        return body.urls[0] === "https://ok.example/"
          ? jsonResponse({ results: [{ url: body.urls[0], raw_content: "# Page\n\ntext" }] })
          : jsonResponse({ results: [], failed_results: [{ url: body.urls[0], error: "blocked" }] });
      },
    });
    expect(await service.extract("https://ok.example/")).toEqual({ markdown: "# Page\n\ntext" });
    expect(await service.extract("https://no.example/")).toEqual({ unreadable: true, reason: "tavily extract: blocked" });
  });

  it("throws a ServiceError on an HTTP error from search", async () => {
    const service = createTavilyService(ENV, { mode: "live", fixturesDir: dir, fetchImpl: async () => jsonResponse({}, 429) });
    await expect(service.search({ query: "x", region: "GB" })).rejects.toMatchObject({ service: "tavily", status: 429 });
  });
});

describe("the Firecrawl adapter", () => {
  it("scrapes main content as markdown with the documented body", async () => {
    let body: unknown;
    const service = createFirecrawlService(ENV, {
      mode: "live",
      fixturesDir: dir,
      fetchImpl: async (_url, init) => {
        body = JSON.parse(String(init?.body));
        return jsonResponse({ success: true, data: { markdown: "# Hello" } });
      },
    });
    expect(await service.scrape("https://x.example/a")).toEqual({ markdown: "# Hello" });
    expect(body).toEqual({ url: "https://x.example/a", formats: ["markdown"], onlyMainContent: true });
  });

  it("never throws: an HTTP error, an empty page or a network failure are unreadable", async () => {
    const failing = createFirecrawlService(ENV, { mode: "live", fixturesDir: dir, fetchImpl: async () => jsonResponse({}, 500) });
    expect(await failing.scrape("https://x.example/")).toEqual({ unreadable: true, reason: "firecrawl: HTTP 500" });
    const empty = createFirecrawlService(ENV, { mode: "live", fixturesDir: dir, fetchImpl: async () => jsonResponse({ success: true, data: { markdown: "  " } }) });
    expect(await empty.scrape("https://x.example/")).toMatchObject({ unreadable: true });
    const network = createFirecrawlService(ENV, {
      mode: "live",
      fixturesDir: dir,
      fetchImpl: async () => {
        throw new Error("ECONNRESET");
      },
    });
    expect(await network.scrape("https://x.example/")).toEqual({ unreadable: true, reason: "firecrawl: request failed" });
  });
});

describe("record, then replay", () => {
  it("writes a recording under the discriminator and the mock reads it back; a miss is honest", async () => {
    const recorder = createTavilyService(ENV, {
      mode: "record",
      fixturesDir: dir,
      fetchImpl: async () => jsonResponse({ results: [{ title: "T", url: "https://t.example/", content: "c" }] }),
    });
    const input = { query: "Vets Orkney", region: "GB" };
    await recorder.search(input);
    const file = recordingPath(dir, "search", searchDiscriminator({ query: "vets orkney ", region: "gb" }));
    expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ tool: "search", args: input, response: { hits: [{ url: "https://t.example/" }] } });

    const mock = createTavilyService(ENV, { mode: "mock", fixturesDir: dir });
    expect(await mock.search({ query: "vets orkney", region: "GB" })).toEqual({ hits: [{ title: "T", url: "https://t.example/", snippet: "c" }] });
    expect(await mock.search({ query: "something else", region: "GB" })).toEqual({ hits: [] });
    expect(await mock.extract("https://never.example/")).toMatchObject({ unreadable: true });

    const scraper = createFirecrawlService(ENV, { mode: "record", fixturesDir: dir, fetchImpl: async () => jsonResponse({ success: true, data: { markdown: "# P" } }) });
    await scraper.scrape("https://t.example/");
    expect(await createFirecrawlService(ENV, { mode: "mock", fixturesDir: dir }).scrape("https://t.example/")).toEqual({ markdown: "# P" });
    expect(fetchDiscriminator("https://t.example/")).toMatch(/^[0-9a-f]{64}$/);
  });
});
