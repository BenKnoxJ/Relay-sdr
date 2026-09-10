import { MODULE_IDS, moduleItems, type CompleteModule, type ModuleId, type PackShape } from "../../agents/research/output.schema";

/**
 * A complete research v3 pack, built in code: every module present and at its
 * floors, three kinds of buyer, every item on its own page so the per-module
 * domain cap never bites and provenance can be satisfied by recording one page
 * per item. The fixture the runtime tests write, assemble and ingest.
 *
 * Dates are relative to now, so the twelve-month rule never ages the fixture.
 */

const daysAgo = (days: number): string => new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
export const RECENT = daysAgo(60);
export const ACCESSED = daysAgo(2);

export const ARCHETYPES = ["claims-teams", "regional-brokers", "delegated-mgas"] as const;

/** Where item number `n` is cited: its own domain, so no module goes over the cap. */
export const itemUrl = (n: number): string => `https://source-${n}.example/page`;

export function goodPack(options: { liveFactId: string }): PackShape {
  let n = 0;
  const item = (id: string, text: string, extra: Record<string, unknown> = {}) => {
    n += 1;
    return {
      id,
      text,
      publishedAt: RECENT,
      accessedAt: ACCESSED,
      evidence: { urls: [itemUrl(n)], primary: false, domains: [`source-${n}.example`] },
      confidence: "weak" as const,
      ...extra,
    };
  };
  const phrase = (id: string, text: string) => ({ ...item(id, text, { quote: text, speaker: "A claims manager", role: "Claims manager" }), say: text, notBuyer: false });
  const hardFilters = { geography: ["GB"], sizeCap: "under 500 staff", subSectorsIn: ["claims teams"], subSectorsOut: ["Lloyd's syndicates"], firmsOut: [], other: [] };
  const live = options.liveFactId;

  const pains = Object.fromEntries(
    ARCHETYPES.map((a) => [a, [1, 2, 3, 4].map((i) => item(`${a}-pain-${i}`, `${a} pain ${i}: handlers say the complaints backlog grew after the storms`))]),
  ) as Record<(typeof ARCHETYPES)[number], ReturnType<typeof item>[]>;

  const modules = {
    m00: {
      status: "complete",
      body: "The spine is the regulator's call-quality guidance.",
      claims: [],
      hardFilters,
      spine: "The regulator's July guidance on call quality.",
      displacement: "Manual sampling of two to five percent of calls.",
      readyNow: ["A complaints backlog in the last quarter."],
      mustNotLead: ["Price."],
      offerHook: [live],
      priorPacksRead: [],
      hypotheses: [],
    },
    repSummary: {
      status: "complete",
      body: "Five lines for the card.",
      claims: [],
      lines: [
        "Reach claims managers at mid-sized UK insurers.",
        "The regulator's July guidance puts call quality on the board's desk.",
        "Open on the backlog their handlers describe.",
        "We could not confirm how many seats each firm runs.",
        "About forty firms fit.",
      ],
    },
    execSummary: {
      status: "complete",
      body: "The wedge is the guidance.",
      claims: [item("exec-1", "The guidance landed in July"), item("exec-2", "Sampling covers two to five percent of calls"), item("exec-3", "Complaints fell last year")],
      wedge: "Every call checked, not a sample.",
      icp: "Mid-sized UK insurers with an in-house claims line.",
      archetypesNamed: ["Claims teams", "Regional brokers", "Delegated MGAs"],
      competitivePosition: "Cheaper than the enterprise tools, deeper than spreadsheets.",
      productConstraints: ["Audio playback is not shipped."],
      verdict: "Worth a three-week campaign.",
    },
    m01: {
      status: "complete",
      body: "The market.",
      claims: [1, 2, 3, 4, 5].map((i) => item(`market-${i}`, `market claim ${i} about UK insurers`)),
      marketSize: ["About 300 insurers."],
      subSegments: [
        { name: "Personal lines insurers", fit: "HIGH", why: "Own claims lines." },
        { name: "Regional brokers", fit: "MEDIUM", why: "Smaller lines." },
        { name: "Delegated MGAs", fit: "MEDIUM", why: "Oversight pressure." },
        { name: "Lloyd's syndicates", fit: "OUT", why: "No consumer line." },
      ],
      bodies: [{ name: "FCA", role: "Conduct regulator", relevance: "Sets the guidance.", url: "https://www.fca.org.uk/" }],
      triggers: [1, 2, 3].map((i) => item(`trigger-${i}`, `trigger ${i}: the regulator published guidance on call quality`)),
      activityMetrics: [],
      nextSixMonths: [],
    },
    m02: {
      status: "complete",
      body: "The competitors.",
      claims: [],
      competitors: [1, 2, 3].map((i) => ({
        name: `Vendor ${i}`,
        positioning: "Contact-centre quality tool.",
        pricingGated: true,
        strengths: [],
        weaknesses: [],
        recentMoves: [item(`vendor-${i}-move`, `vendor ${i} raised prices this spring`)],
      })),
      adjacent: [],
      doNothing: "Keep sampling by hand.",
      pricingTable: [
        { name: "Insights360", price: "per seat" },
        { name: "Vendor 1", price: "on request" },
      ],
      discoveryChannels: ["Trade press."],
    },
    m03: {
      status: "complete",
      body: "Three kinds of buyer.",
      claims: [],
      archetypes: ARCHETYPES.map((a) => ({
        id: a,
        name: `The ${a.replace(/-/g, " ")}`,
        situation: "A mid-sized firm with its own claims line.",
        sizeRange: "50 to 500 staff",
        dominantPain: item(`${a}-dominant`, `${a}: the backlog after the storms is the pain handlers name first`),
        roles: [
          { title: "Head of claims", seniority: "Director", part: "signs", needs: "Proof for the board." },
          { title: "Claims team leader", seniority: "Manager", part: "runs", needs: "Less manual checking." },
        ],
        openingAngle: "Every call checked, not a sample.",
        dealEconomics: { factIds: [], confidence: "speculative", note: "Pricing is not yet confirmed." },
      })),
    },
    m04: {
      status: "complete",
      body: "Targeting.",
      claims: [],
      perArchetype: ARCHETYPES.map((a) => ({
        archetypeId: a,
        recipe: { titles: ["Head of Claims"], excludeTitles: [], sizeBand: { min: 50, max: 500 }, countries: ["GB"], industries: ["Insurance"], triggers: [] },
        hardFiltersEchoed: ["GB only", "under 500 staff"],
        triggerTaxonomy: [1, 2, 3].map((i) => ({ signal: `signal ${i}`, strength: i === 1 ? "HOT" : "WARM", whereToFind: "Trade press" })),
        listSources: [{ name: "FCA register", url: "https://register.fca.org.uk/" }],
        seedFirms: [1, 2].map((i) => ({
          id: `${a}-firm-${i}`,
          name: `${a} firm ${i}`,
          region: "GB",
          size: { status: "unknown" },
          signal: item(`${a}-firm-${i}-signal`, `${a} firm ${i} reported a complaints backlog`),
        })),
      })),
    },
    m05: { status: "complete", body: "Pains.", claims: [], perArchetype: ARCHETYPES.map((a) => ({ archetypeId: a, pains: pains[a] })) },
    m06: {
      status: "complete",
      body: "Their words.",
      claims: [],
      perArchetype: ARCHETYPES.map((a) => ({ archetypeId: a, phrases: [1, 2, 3].map((i) => phrase(`${a}-phrase-${i}`, `${a} phrase ${i}: we are drowning in complaints`)) })),
    },
    m07: {
      status: "complete",
      body: "What answers each pain.",
      claims: [],
      mappings: ARCHETYPES.flatMap((a) => pains[a].map((p) => ({ painId: p.id, capability: "Every call scored", factIds: [live] }))),
      unmatched: [],
    },
    m08: {
      status: "complete",
      body: "The ideal customer.",
      claims: [],
      idealCompany: ["A mid-sized UK insurer."],
      idealBuyer: ["A head of claims under board pressure."],
      disqualifiers: [{ who: "Lloyd's syndicates", why: "No consumer line." }],
      hardFiltersEchoed: hardFilters,
    },
    m09: {
      status: "complete",
      body: "Messaging.",
      claims: [],
      brandConstraints: [],
      perArchetype: ARCHETYPES.map((a) => ({
        archetypeId: a,
        angles: [1, 2, 3, 4, 5].map((rank) => ({ rank, text: `angle ${rank}`, confidence: "weak", channelFit: ["email"] })),
        doDont: [{ use: "every call", avoid: "AI-powered" }],
        verbatim: [1, 2, 3].map((i) => item(`${a}-verbatim-${i}`, `${a} verbatim ${i}: the backlog doubled`)),
        vocabulary: [],
      })),
    },
    m10: {
      status: "complete",
      body: "Where buyers gather.",
      claims: [],
      entries: [1, 2, 3, 4, 5].map((i) => ({ kind: "press", name: `Insurance paper ${i}`, url: `https://press-${i}.example/`, audience: "Claims leaders", why: "They read it." })),
    },
    m11: {
      status: "complete",
      body: "Objections.",
      claims: [],
      perArchetype: ARCHETYPES.map((a) => ({ archetypeId: a, objections: [1, 2, 3].map((i) => ({ objection: `objection ${i}`, factIds: [] })) })),
    },
    m12: { status: "complete", body: "Contact rules.", claims: [], rules: [{ channel: "email", region: "GB", rule: "PECR: corporate subscribers may be emailed.", source: "https://ico.org.uk/", bars: false }] },
    m13: {
      status: "complete",
      body: "Dated events.",
      claims: [],
      entries: [1, 2, 3].map((i) => ({ date: RECENT, what: `event ${i}`, source: `https://events-${i}.example/`, why: "Inside the campaign." })),
      noneFound: false,
      queriesTried: [],
    },
    m14: { status: "complete", body: "No earlier pack.", claims: [], applicable: false, changes: [] },
    m15: { status: "complete", body: "Proof.", claims: [], proof: [{ factId: live, text: "What the facts file allows.", allowed: true }] },
    m16: {
      status: "complete",
      body: "Campaign candidates.",
      claims: [],
      candidates: ARCHETYPES.map((a, i) => ({
        id: `candidate-${a}`,
        rank: i + 1,
        archetypeId: a,
        leadAngle: "Every call checked.",
        channelFit: ["email"],
        whyNow: "The July guidance.",
        seedFirmIds: [`${a}-firm-1`],
        wrongIf: "Complaints keep falling.",
      })),
    },
    m17: { status: "complete", body: "What argues against.", claims: [], entries: [{ id: "against-1", text: "Complaints fell last year.", kind: "against", meaning: "Do not open with drowning." }], noneFound: false },
    m18: { status: "complete", body: "Unknowns.", claims: [], unknowns: [{ id: "unknown-seats", text: "Seat counts per firm.", kind: "not-found", whyItMatters: "Sizes the deal.", queriesTried: ["claims team size UK insurer"] }] },
    m19: { status: "complete", body: "Sources.", claims: [], sources: [{ url: itemUrl(1), title: "Source one", accessedAt: ACCESSED }], knowledgeArticles: ["roadmap"], factsVersion: 1, priorPackIds: [] },
  };
  return { modules, partial: false, missingModules: [] } as unknown as PackShape;
}

/** What the model writes for a module: its fields, without the runtime's `status`. */
export function moduleContent(pack: PackShape, id: ModuleId): Record<string, unknown> {
  const stored = (pack.modules as Record<string, Record<string, unknown> | undefined>)[id];
  if (stored === undefined) throw new Error(`the pack has no ${id}`);
  const content = { ...stored };
  delete content.status;
  return content;
}

/** Every evidence url in the pack with the text a page must carry for the item citing it to pass provenance. */
export function citedPages(pack: PackShape): Array<{ url: string; text: string }> {
  const out: Array<{ url: string; text: string }> = [];
  for (const id of MODULE_IDS) for (const i of moduleItems(pack, id)) for (const url of i.evidence.urls) out.push({ url, text: `${i.text}\n${i.quote ?? ""}` });
  return out;
}

/** One module of a built pack, typed, for a test to edit in place. */
export function mod<M extends ModuleId>(pack: PackShape, id: M): CompleteModule<M> {
  const found = (pack.modules as Record<string, unknown>)[id];
  if (found === undefined) throw new Error(`the pack has no ${id}`);
  return found as CompleteModule<M>;
}
