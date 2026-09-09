import type { PageRead, SearchHit, SearchInput, SearchService } from "../types";
import { fetchDiscriminator, searchDiscriminator } from "../research/discriminator";
import { readRecording } from "../research/recordings";

export type TavilyMockCall = { method: "search"; input: SearchInput } | { method: "extract"; url: string };

/**
 * Deterministic Tavily: recorded responses from `fixturesDir`, and honest
 * misses. A search nobody recorded returns no hits — which the prompt's stop
 * rule turns into an unknown or an `insufficient` — and an extract nobody
 * recorded is unreadable, which the fetch cascade turns into an unknown. Both
 * are what a thin market looks like live, so brief C (vets in Orkney) is a
 * fixture directory with two thin recordings and nothing else.
 */
export class MockTavilyService implements SearchService {
  readonly calls: TavilyMockCall[] = [];

  constructor(private readonly fixturesDir: string) {}

  async search(input: SearchInput): Promise<{ hits: SearchHit[] }> {
    this.calls.push({ method: "search", input });
    const recorded = readRecording<SearchInput, { hits: SearchHit[] }>(this.fixturesDir, "search", searchDiscriminator(input));
    return recorded?.response ?? { hits: [] };
  }

  async extract(url: string): Promise<PageRead> {
    this.calls.push({ method: "extract", url });
    const recorded = readRecording<{ url: string }, PageRead>(this.fixturesDir, "extract", fetchDiscriminator(url));
    return recorded?.response ?? { unreadable: true, reason: "no recording for this url" };
  }
}
