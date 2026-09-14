import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * Lusha under `INTEGRATIONS=mock`: a transport that answers from recorded
 * files, with no network at all. Development and test only; the environment
 * refuses the Lusha provider in mock mode anywhere else.
 *
 * `fixtures/tools/lusha/` holds the metadata the zero-spend check recorded
 * (usage, sizes, industries, countries, the locations it looked up) and a
 * synthetic prospecting page in the recorded V3 shape. A location nobody
 * recorded answers with no places; a search page nobody recorded answers
 * with no people. Anything else is a 404.
 */

export const LUSHA_FIXTURES = resolve(process.cwd(), "fixtures/tools/lusha");

function fileBody(path: string): unknown {
  return (JSON.parse(readFileSync(path, "utf8")) as { body: unknown }).body;
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

/** A location query's recording name: `Orkney Islands` is `orkney-islands.json`. */
export function locationFixtureName(query: string): string {
  return `${query.normalize("NFKC").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}.json`;
}

export function recordedLushaFetch(dir: string = LUSHA_FIXTURES): typeof globalThis.fetch {
  const recorded = (name: string) => join(dir, name);
  return async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = (init?.method ?? "GET").toUpperCase();
    const at = (name: string) => (existsSync(recorded(name)) ? json(fileBody(recorded(name))) : json({ message: "not recorded" }, 404));

    if (method === "GET" && url.pathname === "/v3/account/usage") return at("account-usage.json");
    if (method === "GET" && url.pathname === "/v3/companies/prospecting/filters/sizes") return at("company-sizes.json");
    if (method === "GET" && url.pathname === "/v3/companies/prospecting/filters/industriesLabels") return at("company-industries.json");
    if (method === "GET" && url.pathname === "/v3/contacts/prospecting/filters/countries") return at("contact-countries.json");
    if (method === "GET" && url.pathname === "/v3/contacts/prospecting/filters/locations") {
      const name = `locations/${locationFixtureName(url.searchParams.get("query") ?? "")}`;
      return existsSync(recorded(name)) ? json(fileBody(recorded(name))) : json({ values: [] });
    }
    if (method === "POST" && url.pathname === "/v3/contacts/prospecting") {
      const request = JSON.parse(String(init?.body ?? "{}")) as { pagination?: { page?: number; size?: number } };
      const page = request.pagination?.page ?? 0;
      const name = `prospecting/page-${page}.json`;
      if (existsSync(recorded(name))) return json(fileBody(recorded(name)));
      return json({ results: [], billing: { creditsCharged: 0, resultsReturned: 0 }, pagination: { page, size: request.pagination?.size ?? 0, total: 0 } });
    }
    return json({ message: "not recorded" }, 404);
  };
}
