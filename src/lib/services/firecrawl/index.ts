import type { Env } from "@/lib/env";

import { fetchDiscriminator } from "../research/discriminator";
import { writeRecording } from "../research/recordings";
import type { ResearchServiceMode } from "../tavily";
import type { FetchService, PageRead } from "../types";
import { LiveFirecrawlService } from "./live";
import { MockFirecrawlService } from "./mock";

export { LiveFirecrawlService } from "./live";
export { MockFirecrawlService } from "./mock";

export function createFirecrawlService(
  env: Pick<Env, "FIRECRAWL_API_KEY">,
  options: { mode: ResearchServiceMode; fixturesDir: string; fetchImpl?: typeof fetch },
): FetchService {
  if (options.mode === "mock") return new MockFirecrawlService(options.fixturesDir);
  const live = new LiveFirecrawlService(env, options.fetchImpl);
  if (options.mode === "live") return live;
  const dir = options.fixturesDir;
  return {
    async scrape(url: string): Promise<PageRead> {
      const response = await live.scrape(url);
      writeRecording(dir, "scrape", fetchDiscriminator(url), { tool: "scrape", args: { url }, response });
      return response;
    },
  };
}
