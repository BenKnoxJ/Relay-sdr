import type { Env } from "@/lib/env";

import { ServiceError, type FetchService, type PageRead } from "../types";

/**
 * Live Firecrawl scrape: a page's main content as markdown (research v2 §4).
 *
 * `{ formats: ["markdown"], onlyMainContent: true }` is the shape
 * `firecrawl-mcp@3.17.0` documents as its canonical example. Firecrawl's v2
 * scrape has no timeout field in that version, so the deadline is this
 * client's own. A failure of any kind is returned as unreadable, not thrown:
 * the fetch cascade's next tier decides what to do with it, and the run does
 * not fail because one page did.
 */

const SCRAPE_URL = "https://api.firecrawl.dev/v2/scrape";
const TIMEOUT_MS = 30_000;

type FirecrawlScrapeResponse = {
  success?: boolean;
  data?: { markdown?: string };
  error?: string;
};

export class LiveFirecrawlService implements FetchService {
  constructor(
    private readonly env: Pick<Env, "FIRECRAWL_API_KEY">,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    if (env.FIRECRAWL_API_KEY === undefined) throw new ServiceError({ service: "firecrawl", status: 401, message: "FIRECRAWL_API_KEY is not set" });
  }

  async scrape(url: string): Promise<PageRead> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const response = await this.fetchImpl(SCRAPE_URL, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          authorization: `Bearer ${this.env.FIRECRAWL_API_KEY}`,
        },
        body: JSON.stringify({ url, formats: ["markdown"], onlyMainContent: true }),
        signal: controller.signal,
      });
      if (!response.ok) return { unreadable: true, reason: `firecrawl: HTTP ${response.status}` };
      const data = (await response.json()) as FirecrawlScrapeResponse;
      const markdown = data.data?.markdown;
      if (data.success === false || typeof markdown !== "string" || markdown.trim().length === 0) {
        return { unreadable: true, reason: `firecrawl: ${data.error ?? "no content"}` };
      }
      return { markdown };
    } catch {
      return { unreadable: true, reason: controller.signal.aborted ? "firecrawl: timed out" : "firecrawl: request failed" };
    } finally {
      clearTimeout(timer);
    }
  }
}
