import { z } from "zod";

import type { LiveDeps } from "../types";

/**
 * Lusha's REST API V3: the account usage read, the free prospecting filter
 * reads, and contact prospecting (search). Nothing here enriches or reveals.
 *
 * Verified against the live API by the zero-spend check of 2026-09-14
 * (`fixtures/tools/lusha/`): the `api_key` header, `GET /v3/account/usage`,
 * and the filter reads, none of which moved the account's credits.
 *
 * The key goes in one header and nowhere else: no error, log line or thrown
 * message carries it. Errors name the path and the status only.
 */

export const LUSHA_API = "https://api.lusha.com";
const TIMEOUT_MS = 20_000;

/** The API answered with a status that is not success. 429 is its load refusal. */
export class LushaHttpError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
  ) {
    super(`lusha: ${path} answered ${status}`);
    this.name = "LushaHttpError";
  }
}

/** No answer arrived: a timeout or a network failure. A search may or may not have been charged. */
export class LushaNoAnswerError extends Error {
  constructor(
    readonly path: string,
    readonly timedOut: boolean,
  ) {
    super(`lusha: ${path} ${timedOut ? "timed out" : "failed before an answer arrived"}`);
    this.name = "LushaNoAnswerError";
  }
}

/** A success status whose body is not the shape Relay reads. */
export class LushaBadResponseError extends Error {
  constructor(readonly path: string) {
    super(`lusha: ${path} answered with a body Relay cannot read`);
    this.name = "LushaBadResponseError";
  }
}

const text = z.string().nullish();
const id = z.union([z.string(), z.number()]).transform(String);

const usageSchema = z.object({
  credits: z.object({ total: z.number(), used: z.number(), remaining: z.number() }),
  pricing: z.record(z.object({ credits: z.number(), perQuantity: z.number() })).optional(),
});

const sizesSchema = z.object({ values: z.array(z.object({ min: z.number().int(), max: z.number().int().nullish() })) });

const industriesSchema = z.object({
  values: z.array(
    z.object({
      main_industry: z.string(),
      main_industry_id: z.number().int(),
      sub_industries: z.array(z.object({ value: z.string(), id: z.number().int() })),
    }),
  ),
});

const countriesSchema = z.object({ values: z.array(z.object({ name: z.string(), code: z.string() })) });

const locationsSchema = z.object({
  values: z.array(z.object({ continent: text, country: text, state: text, city: text })),
});

const resultSchema = z.object({
  id,
  firstName: text,
  lastName: text,
  jobTitle: z.object({ title: text, seniority: text, departments: z.array(z.string()).nullish() }).nullish(),
  company: z.object({ id: id.nullish(), name: text, domain: text }).nullish(),
  location: z.object({ country: text, state: text, city: text }).nullish(),
  socialLinks: z.object({ linkedin: text }).nullish(),
  has: z.array(z.string()).nullish(),
  canReveal: z.array(z.object({ field: z.string(), credits: z.number() })).nullish(),
});

const searchSchema = z.object({
  results: z.array(resultSchema),
  billing: z.object({ creditsCharged: z.number().int().nonnegative(), resultsReturned: z.number().int().nonnegative() }),
  pagination: z.object({ page: z.number().int(), size: z.number().int(), total: z.number().int().nullish() }).nullish(),
});

export type LushaUsage = z.infer<typeof usageSchema>;
export type LushaSizes = z.infer<typeof sizesSchema>["values"];
export type LushaIndustries = z.infer<typeof industriesSchema>["values"];
export type LushaCountries = z.infer<typeof countriesSchema>["values"];
export type LushaLocations = z.infer<typeof locationsSchema>["values"];
export type LushaContact = z.infer<typeof resultSchema>;
export type LushaSearchPage = z.infer<typeof searchSchema>;

/** A contact prospecting request, as V3 takes it. Built by lead gen's adapter. */
export type LushaContactSearch = {
  filters: {
    contacts: { include: { jobTitles?: string[]; countries?: string[]; locations?: Record<string, string>[] } };
    companies?: { include: { sizes?: { min: number; max?: number }[]; mainIndustriesIds?: number[]; subIndustriesIds?: number[] } };
  };
  options?: { maxContactsPerCompany: number };
  pagination: { page: number; size: number };
};

export type LushaClientDeps = LiveDeps & { timeoutMs?: number; baseUrl?: string };

export class LushaClient {
  /** What the metadata cache is keyed on: one per API and mode, never the key. */
  readonly cacheKey: string;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly timeoutMs: number;
  private readonly baseUrl: string;

  constructor(
    private readonly apiKey: string,
    deps: LushaClientDeps & { cacheKey?: string } = {},
  ) {
    this.fetchImpl = deps.fetchImpl ?? globalThis.fetch;
    this.timeoutMs = deps.timeoutMs ?? TIMEOUT_MS;
    this.baseUrl = deps.baseUrl ?? LUSHA_API;
    this.cacheKey = deps.cacheKey ?? this.baseUrl;
  }

  usage(): Promise<LushaUsage> {
    return this.request("GET", "/v3/account/usage", usageSchema);
  }

  async sizes(): Promise<LushaSizes> {
    return (await this.request("GET", "/v3/companies/prospecting/filters/sizes", sizesSchema)).values;
  }

  async industries(): Promise<LushaIndustries> {
    return (await this.request("GET", "/v3/companies/prospecting/filters/industriesLabels", industriesSchema)).values;
  }

  async countries(): Promise<LushaCountries> {
    return (await this.request("GET", "/v3/contacts/prospecting/filters/countries", countriesSchema)).values;
  }

  /** Places matching a name (2 to 256 characters), as literal values: there are no location ids. */
  async locations(query: string): Promise<LushaLocations> {
    return (await this.request("GET", `/v3/contacts/prospecting/filters/locations?query=${encodeURIComponent(query)}`, locationsSchema)).values;
  }

  /** Contact prospecting: a spend event, charged by the API and reported in `billing`. */
  searchContacts(search: LushaContactSearch): Promise<LushaSearchPage> {
    return this.request("POST", "/v3/contacts/prospecting", searchSchema, search);
  }

  private async request<T extends z.ZodTypeAny>(method: "GET" | "POST", path: string, schema: T, body?: unknown): Promise<z.infer<T>> {
    const endpoint = path.split("?")[0]!;
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: { api_key: this.apiKey, accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      const name = error instanceof Error ? error.name : "";
      throw new LushaNoAnswerError(endpoint, name === "TimeoutError" || name === "AbortError");
    }
    if (!res.ok) throw new LushaHttpError(res.status, endpoint);
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      throw new LushaBadResponseError(endpoint);
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) throw new LushaBadResponseError(endpoint);
    return parsed.data;
  }
}
