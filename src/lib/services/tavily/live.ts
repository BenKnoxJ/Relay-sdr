import type { Env } from "@/lib/env";

import { ServiceError, type PageRead, type SearchHit, type SearchInput, type SearchService } from "../types";

/**
 * Live Tavily client: search and extract (research v2 §4).
 *
 * REST, not the MCP server the fleet's Signal uses: a REST call is one
 * function with a mock beside it and no session, and the shapes below are
 * read off `tavily-mcp@0.2.19`'s own request builder. Bearer auth; no key in
 * the body.
 */

const SEARCH_URL = "https://api.tavily.com/search";
const EXTRACT_URL = "https://api.tavily.com/extract";
const TIMEOUT_MS = 30_000;
/** Tavily's floor and the tool's ask (research §4: "top 8"). */
const MIN_RESULTS = 5;
const DEFAULT_RESULTS = 8;

/**
 * Tavily wants a country *name*, not a code (`tavily-mcp` schema: "must be a
 * full country name"). The brief carries ISO-3166 alpha-2 (research §2), so the
 * adapter maps. Unmapped is an error, not a silent global search: a region the
 * rep chose and the provider ignored is a pack about the wrong market.
 */
export const COUNTRY_NAMES: Record<string, string> = {
  GB: "united kingdom",
  IE: "ireland",
  US: "united states",
  CA: "canada",
  AU: "australia",
  NZ: "new zealand",
  DE: "germany",
  FR: "france",
  NL: "netherlands",
  BE: "belgium",
  ES: "spain",
  IT: "italy",
  PT: "portugal",
  SE: "sweden",
  NO: "norway",
  DK: "denmark",
  FI: "finland",
  CH: "switzerland",
  AT: "austria",
  PL: "poland",
  SG: "singapore",
  JP: "japan",
  IN: "india",
  ZA: "south africa",
  AE: "united arab emirates",
};

export function countryName(region: string): string {
  const name = COUNTRY_NAMES[region.toUpperCase()];
  if (name === undefined) throw new ServiceError({ service: "tavily", status: 400, message: `no country name for region ${JSON.stringify(region)}; add it to COUNTRY_NAMES` });
  return name;
}

/** Tavily's `time_range` vocabulary from a months figure. */
export function timeRange(recencyMonths: number | undefined): "week" | "month" | "year" | undefined {
  if (recencyMonths === undefined) return undefined;
  if (recencyMonths <= 0.25) return "week";
  if (recencyMonths <= 1) return "month";
  if (recencyMonths <= 12) return "year";
  return undefined;
}

type TavilySearchResponse = {
  results?: Array<{ title?: string; url?: string; content?: string; published_date?: string | null }>;
};
type TavilyExtractResponse = {
  results?: Array<{ url?: string; raw_content?: string }>;
  failed_results?: Array<{ url?: string; error?: string }>;
};

export class LiveTavilyService implements SearchService {
  constructor(
    private readonly env: Pick<Env, "TAVILY_API_KEY">,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    if (env.TAVILY_API_KEY === undefined) throw new ServiceError({ service: "tavily", status: 401, message: "TAVILY_API_KEY is not set" });
  }

  async search(input: SearchInput): Promise<{ hits: SearchHit[] }> {
    const range = timeRange(input.recencyMonths);
    const body = {
      query: input.query,
      search_depth: "basic",
      topic: "general",
      max_results: Math.min(20, Math.max(MIN_RESULTS, input.maxResults ?? DEFAULT_RESULTS)),
      country: countryName(input.region),
      include_raw_content: false,
      ...(range === undefined ? {} : { time_range: range }),
    };
    const data = await this.post<TavilySearchResponse>(SEARCH_URL, body);
    const wanted = input.maxResults ?? DEFAULT_RESULTS;
    const hits: SearchHit[] = [];
    for (const result of data.results ?? []) {
      if (typeof result.url !== "string" || result.url.length === 0) continue;
      hits.push({
        title: typeof result.title === "string" ? result.title : "",
        url: result.url,
        snippet: typeof result.content === "string" ? result.content : "",
        ...(typeof result.published_date === "string" && result.published_date.length > 0
          ? { publishedAt: isoDate(result.published_date) }
          : {}),
      });
      if (hits.length >= wanted) break;
    }
    return { hits };
  }

  async extract(url: string): Promise<PageRead> {
    let data: TavilyExtractResponse;
    try {
      data = await this.post<TavilyExtractResponse>(EXTRACT_URL, { urls: [url], extract_depth: "basic" });
    } catch (error) {
      return { unreadable: true, reason: error instanceof ServiceError ? `tavily extract: HTTP ${error.status}` : "tavily extract: request failed" };
    }
    const hit = data.results?.[0];
    if (hit === undefined || typeof hit.raw_content !== "string" || hit.raw_content.trim().length === 0) {
      const failed = data.failed_results?.[0]?.error;
      return { unreadable: true, reason: `tavily extract: ${failed ?? "no content"}` };
    }
    return { markdown: hit.raw_content };
  }

  private async post<T>(url: string, body: unknown): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const response = await this.fetchImpl(url, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          authorization: `Bearer ${this.env.TAVILY_API_KEY}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!response.ok) throw new ServiceError({ service: "tavily", status: response.status, message: `tavily: HTTP ${response.status}` });
      return (await response.json()) as T;
    } catch (error) {
      if (error instanceof ServiceError) throw error;
      throw new ServiceError({ service: "tavily", status: 0, message: controller.signal.aborted ? "tavily: timed out" : "tavily: request failed", cause: error });
    } finally {
      clearTimeout(timer);
    }
  }
}

/** `2026-03-05` from whatever date string the provider sent, or the string itself. */
function isoDate(value: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString().slice(0, 10);
}
