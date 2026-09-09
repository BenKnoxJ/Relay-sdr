import type { Env } from "@/lib/env";

import { fetchDiscriminator, searchDiscriminator } from "../research/discriminator";
import { writeRecording } from "../research/recordings";
import type { PageRead, SearchHit, SearchInput, SearchService } from "../types";
import { LiveTavilyService } from "./live";
import { MockTavilyService } from "./mock";

export { LiveTavilyService, COUNTRY_NAMES, countryName, timeRange } from "./live";
export { MockTavilyService } from "./mock";

export type ResearchServiceMode = "mock" | "live" | "record";

/**
 * A Tavily service in one of three modes. `mock` replays `fixturesDir`;
 * `live` calls the API; `record` calls the API and writes every response into
 * `fixturesDir`, so a brief is recorded once and replayed forever.
 */
export function createTavilyService(
  env: Pick<Env, "TAVILY_API_KEY">,
  options: { mode: ResearchServiceMode; fixturesDir: string; fetchImpl?: typeof fetch },
): SearchService {
  if (options.mode === "mock") return new MockTavilyService(options.fixturesDir);
  const live = new LiveTavilyService(env, options.fetchImpl);
  if (options.mode === "live") return live;
  return new RecordingTavilyService(live, options.fixturesDir);
}

class RecordingTavilyService implements SearchService {
  constructor(
    private readonly live: SearchService,
    private readonly dir: string,
  ) {}
  async search(input: SearchInput): Promise<{ hits: SearchHit[] }> {
    const response = await this.live.search(input);
    writeRecording(this.dir, "search", searchDiscriminator(input), { tool: "search", args: input, response });
    return response;
  }
  async extract(url: string): Promise<PageRead> {
    const response = await this.live.extract(url);
    writeRecording(this.dir, "extract", fetchDiscriminator(url), { tool: "extract", args: { url }, response });
    return response;
  }
}
