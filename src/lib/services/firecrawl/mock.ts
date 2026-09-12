import type { FetchService, PageRead } from "../types";
import { fetchDiscriminator } from "../research/discriminator";
import { readRecording } from "../research/recordings";

export type FirecrawlMockCall = { method: "scrape"; url: string };

/** Deterministic Firecrawl: a recorded page, or unreadable. */
export class MockFirecrawlService implements FetchService {
  readonly calls: FirecrawlMockCall[] = [];

  constructor(private readonly fixturesDir: string) {}

  async scrape(url: string): Promise<PageRead> {
    this.calls.push({ method: "scrape", url });
    const recorded = readRecording<{ url: string }, PageRead>(this.fixturesDir, "scrape", fetchDiscriminator(url));
    return recorded?.response ?? { unreadable: true, reason: "no recording for this url" };
  }
}
