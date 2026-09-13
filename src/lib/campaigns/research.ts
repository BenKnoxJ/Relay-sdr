import { hostOf } from "../../../agents/_shared/item.schema";
import { completeModule, type ModuleId, type PackShape } from "../../../agents/research/output.schema";

import { researchCopy } from "@/lib/copy/research";

import {
  buyerLanguage,
  candidateFor,
  groupName,
  groupsByRank,
  leadAngle,
  nonBuyerVoices,
  researchContradictions,
  researchGaps,
  researchedOn,
  seedFirmsByGroup,
  sourceCount,
  type ResearchGap,
} from "./packSelectors";
import { cleanContradiction, cleanGap, cleanItem, cleanPhrase, readable } from "./readable";
import type { CampaignResearch, GapGroupKind, PainRef, ResearchAngle, ResearchFinding, ResearchPart, TimelineEntry } from "./types";

/**
 * "What Relay learned" (task 19): the whole of a finished pack, read into the
 * eleven parts of the research page.
 *
 * Everything here is a lookup into the stored pack. The readings the Overview
 * also makes (which group ranks first, whose words are whose, how many
 * sources, the example firms, the gaps) go through the same shared selectors,
 * so the two screens can differ in how much they show and never in what it
 * means. There is no model and no rewording.
 *
 * Three things are done to what research wrote, and only these:
 *
 * - **Internal names come out.** A fact id cited in brackets is dropped, and
 *   a part of the pack named by its id ("m12") becomes the part of this page
 *   that shows it. Neither is a word a rep has.
 * - **What research wrote twice is shown once.** Each rule is exact and
 *   written out where it applies: a trigger on the day of a dated event sits
 *   under that event; a coming date that is already an event is not repeated;
 *   a boundary research echoed per group is shown once; a don't-claim written
 *   in two places is shown once; a line from the sources repeated for a second
 *   group is shown under the first.
 * - **A part the run did not write is named, not filled.** Each part of the
 *   page knows which of the pack's parts it draws on were left unwritten.
 */

/** How two strings are compared for "the same line": case, spacing and internal names aside. */
const same = (text: string): string => readable(text).toLowerCase().replace(/\s+/g, " ").trim();

/** Which of the pack's parts each part of the page draws on. */
const DRAWS_ON: Record<ResearchPart, ModuleId[]> = {
  market: ["m00", "m01", "m13"],
  who: ["m03", "m08", "m00", "m16", "execSummary"],
  pains: ["m05", "m06"],
  say: ["m09", "m16", "execSummary"],
  prove: ["m07", "m11", "m15", "m00", "m09", "execSummary"],
  competition: ["m02", "execSummary"],
  companies: ["m04"],
  gather: ["m10", "m02"],
  contact: ["m12"],
  gaps: ["m17", "m18"],
  sources: ["m19"],
};

/** Where each kind of unknown (m18) and contradiction (m17) is read, by what it means for the rep. */
const GAP_GROUP: Record<ResearchGap["kind"], GapGroupKind> = {
  "not-found": "ask",
  conflicting: "conflict",
  "confirmed-absent": "careful",
  "out-of-budget": "verify",
  unreadable: "unreadable",
};
const GAP_ORDER: GapGroupKind[] = ["ask", "conflict", "careful", "verify", "unreadable"];

const GATHER_ORDER = ["event", "association", "publication", "community", "review-site", "press"] as const;

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

/** The day a line opens with ("22 October 2026 — …", "18–19 November 2026 — …"), as `YYYY-MM-DD`, or null. */
function leadingDay(line: string): string | null {
  const match = /^(\d{1,2})(?:\s*[–-]\s*\d{1,2})?\s+([A-Za-z]+)\s+(\d{4})\b/.exec(line.trim());
  if (match === null) return null;
  const month = MONTHS.indexOf(match[2]!.toLowerCase());
  if (month < 0) return null;
  return `${match[3]}-${String(month + 1).padStart(2, "0")}-${match[1]!.padStart(2, "0")}`;
}

/** The last day a date can mean: a year is its 31 December, a month its 31st. For "is it still to come". */
function lastDay(date: string): string {
  return date.length === 4 ? `${date}-12-31` : date.length === 7 ? `${date}-31` : date.slice(0, 10);
}

function timelineOf(pack: PackShape, asOf: string | null): { timeline: TimelineEntry[]; alsoExpected: string[] } {
  const events = (completeModule(pack, "m13")?.entries ?? []).map(
    (entry): Extract<TimelineEntry, { kind: "event" }> => ({
      kind: "event",
      key: entry.id,
      date: entry.date,
      what: readable(entry.what),
      why: readable(entry.why),
      source: entry.source,
      alsoReported: [],
      comingUp: null,
    }),
  );
  const onDay = new Map<string, Extract<TimelineEntry, { kind: "event" }>>();
  for (const event of events) if (event.date.length === 10 && !onDay.has(event.date)) onDay.set(event.date, event);

  // A trigger dated the day of an event is reported under it, never as a second entry for the same day.
  const triggers: TimelineEntry[] = [];
  for (const trigger of completeModule(pack, "m01")?.triggers ?? []) {
    const date = trigger.publishedAt === undefined ? null : trigger.publishedAt.slice(0, 10);
    const event = date === null ? undefined : onDay.get(date);
    if (event !== undefined) event.alsoReported.push(cleanItem(trigger));
    else triggers.push({ kind: "trigger", key: trigger.id, date, item: cleanItem(trigger), comingUp: null });
  }

  const dated = [...events, ...triggers]
    .map((entry) => ({
      ...entry,
      // A trigger is from the last twelve months by definition, so one research could not date has happened.
      comingUp: asOf === null ? null : entry.date === null ? false : lastDay(entry.date) >= asOf,
    }))
    .sort((a, b) => (a.date === null ? 1 : b.date === null ? -1 : a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  // A coming date the timeline already has, on the same day, is not said twice.
  const days = new Set(dated.map((entry) => entry.date).filter((date): date is string => date !== null));
  const alsoExpected = (completeModule(pack, "m01")?.nextSixMonths ?? []).filter((line) => {
    const day = leadingDay(line);
    return day === null || !days.has(day);
  });

  return { timeline: dated, alsoExpected: alsoExpected.map(readable) };
}

export { readable } from "./readable";

export function researchSections(pack: PackShape): CampaignResearch {
  const groups = groupsByRank(pack);
  const place = new Map(groups.map((group, index) => [group.id, index + 1]));
  const asOf = researchedOn(pack);

  const unwritten = Object.fromEntries(
    (Object.entries(DRAWS_ON) as [ResearchPart, ModuleId[]][]).map(([part, ids]) => [part, ids.filter((id) => completeModule(pack, id) === undefined)]),
  ) as Record<ResearchPart, string[]>;

  const m00 = completeModule(pack, "m00");
  const m01 = completeModule(pack, "m01");
  const m02 = completeModule(pack, "m02");
  const m04 = completeModule(pack, "m04");
  const m05 = completeModule(pack, "m05");
  const m07 = completeModule(pack, "m07");
  const m08 = completeModule(pack, "m08");
  const m09 = completeModule(pack, "m09");
  const m10 = completeModule(pack, "m10");
  const m11 = completeModule(pack, "m11");
  const m12 = completeModule(pack, "m12");
  const m15 = completeModule(pack, "m15");
  const exec = completeModule(pack, "execSummary");

  // --- The market and why now
  const { timeline, alsoExpected } = timelineOf(pack, asOf);

  // --- Pains, by place, so another part can point at one.
  const painRefs = new Map<string, PainRef>();
  for (const group of groups) {
    (m05?.perArchetype.find((entry) => entry.archetypeId === group.id)?.pains ?? []).forEach((pain, index) =>
      painRefs.set(pain.id, { group: place.get(group.id)!, pain: index + 1 }),
    );
  }
  const refTo = (painId: string): PainRef | null => painRefs.get(painId) ?? null;

  // --- Don't claim: every constraint research wrote, each once.
  const claimed = new Set<string>();
  const once = <T>(list: T[], text: (entry: T) => string): T[] =>
    list.filter((entry) => {
      const key = same(text(entry));
      if (claimed.has(key)) return false;
      claimed.add(key);
      return true;
    });
  const dontClaim = {
    lead: once(m00?.mustNotLead ?? [], (line) => line).map(readable),
    product: once(exec?.productConstraints ?? [], (line) => line).map(readable),
    brand: once(m09?.brandConstraints ?? [], (line) => line).map(readable),
    imply: once(
      (m07?.mappings ?? []).flatMap((mapping, index) =>
        mapping.mustNotImply === undefined ? [] : [{ key: `imply-${index}`, pain: refTo(mapping.painId), text: readable(mapping.mustNotImply) }],
      ),
      (entry) => entry.text,
    ),
    proof: once(
      (m15?.proof ?? []).flatMap((proof, index) =>
        proof.allowed ? [] : [{ key: `proof-${index}`, text: readable(proof.text), ...(proof.note === undefined ? {} : { note: readable(proof.note) }) }],
      ),
      (entry) => entry.text,
    ),
  };

  // --- Hard boundaries, once. A group's echo of one is not shown again.
  const filters = m00?.hardFilters ?? m08?.hardFiltersEchoed;
  const boundaries =
    filters === undefined
      ? null
      : {
          geography: filters.geography.map(readable),
          size: filters.sizeCap === undefined ? null : readable(String(filters.sizeCap)),
          sectorsIn: filters.subSectorsIn.map(readable),
          sectorsOut: filters.subSectorsOut.map(readable),
          firmsOut: filters.firmsOut.map(readable),
          other: filters.other.map(readable),
        };
  const shownOnce = new Set(
    [
      ...(boundaries === null ? [] : [...boundaries.geography, ...(boundaries.size === null ? [] : [boundaries.size]), ...boundaries.sectorsIn, ...boundaries.sectorsOut, ...boundaries.firmsOut, ...boundaries.other]),
      ...(m00?.mustNotLead ?? []),
      ...(exec?.productConstraints ?? []),
      ...(m09?.brandConstraints ?? []),
    ].map(same),
  );
  const groupBoundaries = (m04?.perArchetype ?? []).flatMap((targeting) => {
    const group = place.get(targeting.archetypeId);
    const lines = targeting.hardFiltersEchoed.filter((line) => !shownOnce.has(same(line))).map(readable);
    return group === undefined || lines.length === 0 ? [] : [{ group, lines }];
  });

  // --- Lines from the sources: one repeated for a later group is shown under the first.
  const quoted = new Set<string>();

  // --- The dated events a venue is also on (same day, same site): the venue says so rather than repeating them.
  const eventDays = timeline.filter((entry) => entry.kind === "event").map((entry) => ({ date: entry.date, host: entry.kind === "event" ? hostOf(entry.source) : "" }));

  return {
    sources: sourceCount(pack),
    researchedOn: asOf,
    partial: pack.partial && pack.insufficient === undefined ? [...pack.missingModules] : [],
    unwritten,

    market: {
      theCase: m00 === undefined ? null : readable(m00.spine),
      timeline,
      alsoExpected,
      segments: (m01?.subSegments ?? []).map((segment, index) => ({
        key: `segment-${index}`,
        name: segment.name,
        fit: segment.fit,
        why: readable(segment.why),
        ...(segment.sizeRange === undefined ? {} : { sizeRange: segment.sizeRange }),
        ...(segment.countEstimate === undefined ? {} : { countEstimate: readable(segment.countEstimate) }),
      })),
      size: (m01?.marketSize ?? []).map(readable),
      measures: (m01?.activityMetrics ?? []).map(readable),
      bodies: (m01?.bodies ?? []).map((body, index) => ({
        key: `body-${index}`,
        name: body.name,
        role: readable(body.role),
        relevance: readable(body.relevance),
        ...(body.url === undefined ? {} : { url: body.url }),
      })),
    },

    who: {
      intro: exec === undefined ? null : readable(exec.icp),
      groups: groups.map((group, index) => {
        const candidate = candidateFor(pack, group.id);
        // The fact ids the figures rest on are research's references, not words: everything else is shown.
        const { seatRange, plan, yearOneValue, salesCycle, budgetLine, confidence, note } = group.dealEconomics;
        const deal = { seatRange, plan, yearOneValue, salesCycle, budgetLine, confidence, note };
        return {
          key: `group-${index + 1}`,
          name: group.name,
          rank: candidate?.rank ?? null,
          situation: readable(group.situation),
          sizeRange: group.sizeRange,
          dominantPain: cleanItem(group.dominantPain),
          roles: group.roles.map((role) => ({ part: role.part, title: role.title, seniority: role.seniority, needs: readable(role.needs) })),
          whyNow: candidate === undefined ? null : readable(candidate.whyNow),
          wrongIf: candidate === undefined ? null : readable(candidate.wrongIf),
          deal: {
            ...deal,
            ...(deal.yearOneValue === undefined ? {} : { yearOneValue: readable(deal.yearOneValue) }),
            ...(deal.note === undefined ? {} : { note: readable(deal.note) }),
          },
        };
      }),
      idealCompany: (m08?.idealCompany ?? []).map(readable),
      idealBuyer: (m08?.idealBuyer ?? []).map(readable),
      disqualifiers: (m08?.disqualifiers ?? []).map((entry) => ({ who: readable(entry.who), why: readable(entry.why) })),
      boundaries,
      groupBoundaries,
    },

    pains: {
      groups: groups.flatMap((group, index) => {
        const pains = (m05?.perArchetype.find((entry) => entry.archetypeId === group.id)?.pains ?? []).map(cleanItem);
        const buyerWords = buyerLanguage(pack, group.id).buyer.map(cleanPhrase);
        const otherVoices = nonBuyerVoices(pack, group.id).map(({ voice, phrase }) => ({ voice, phrase: cleanPhrase(phrase) }));
        return pains.length + buyerWords.length + otherVoices.length === 0 ? [] : [{ key: `group-${index + 1}`, name: group.name, pains, buyerWords, otherVoices }];
      }),
    },

    say: {
      intro: exec === undefined ? null : readable(exec.wedge),
      groups: groups.flatMap((group, index) => {
        const messaging = m09?.perArchetype.find((entry) => entry.archetypeId === group.id);
        const candidate = candidateFor(pack, group.id);
        // The lead is the Overview's own reading (`leadAngle`). An id it could not resolve is never shown.
        const lead = candidate === undefined ? null : leadAngle(pack, candidate);
        const leadText = lead !== null && /\s/.test(lead) ? lead : null;
        const ranked: ResearchAngle[] = (messaging?.angles ?? [])
          .slice()
          .sort((a, b) => a.rank - b.rank)
          .map((angle) => ({ key: angle.id, text: readable(angle.text), channels: [...angle.channelFit], confidence: angle.confidence, lead: angle.text === leadText }));
        const angles: ResearchAngle[] =
          leadText === null || ranked.some((angle) => angle.lead)
            ? ranked.slice().sort((a, b) => Number(b.lead) - Number(a.lead))
            : [{ key: "lead", text: readable(leadText), channels: [...(candidate?.channelFit ?? [])], confidence: null, lead: true }, ...ranked];
        const verbatim = (messaging?.verbatim ?? []).filter((line) => {
          const key = same(line.quote ?? line.text);
          if (quoted.has(key)) return false;
          quoted.add(key);
          return true;
        });
        const entry = {
          key: `group-${index + 1}`,
          name: group.name,
          angles,
          doDont: (messaging?.doDont ?? []).map((row) => ({ use: readable(row.use), avoid: readable(row.avoid), ...(row.why === undefined ? {} : { why: readable(row.why) }) })),
          verbatim: verbatim.map(cleanItem),
          vocabulary: [...(messaging?.vocabulary ?? [])],
        };
        return entry.angles.length + entry.doDont.length + entry.verbatim.length + entry.vocabulary.length === 0 ? [] : [entry];
      }),
    },

    prove: {
      groups: (() => {
        const answersOf = (inGroup: (ref: PainRef | null) => boolean) => ({
          answers: (m07?.mappings ?? []).flatMap((mapping, index) =>
            inGroup(refTo(mapping.painId)) ? [{ key: `answer-${index}`, pain: refTo(mapping.painId), capability: readable(mapping.capability), strength: mapping.strength }] : [],
          ),
          unanswered: (m07?.unmatched ?? []).flatMap((entry, index) =>
            inGroup(refTo(entry.painId))
              ? [{ key: `unanswered-${index}`, pain: refTo(entry.painId), status: readable(entry.roadmapStatus), ...(entry.note === undefined ? {} : { note: readable(entry.note) }) }]
              : [],
          ),
        });
        const byGroup = groups.flatMap((group, index) => {
          const own = answersOf((ref) => ref?.group === index + 1);
          const objections = (m11?.perArchetype.find((entry) => entry.archetypeId === group.id)?.objections ?? []).map((objection) => ({
            key: objection.id,
            objection: readable(objection.objection),
            answer: objection.answer === undefined ? null : readable(objection.answer),
            notToday: (objection.notYetFactIds?.length ?? 0) > 0,
          }));
          return own.answers.length + own.unanswered.length + objections.length === 0 ? [] : [{ key: `group-${index + 1}`, name: group.name, ...own, objections }];
        });
        // A pain research mapped that no named group owns (a run cut short before its pains): shown, never dropped.
        const loose = answersOf((ref) => ref === null);
        return loose.answers.length + loose.unanswered.length === 0 ? byGroup : [...byGroup, { key: "other", name: researchCopy.otherPains, ...loose, objections: [] }];
      })(),
      proof: (m15?.proof ?? []).flatMap((proof, index) =>
        proof.allowed ? [{ key: `proof-${index}`, text: readable(proof.text), ...(proof.note === undefined ? {} : { note: readable(proof.note) }) }] : [],
      ),
      dontClaim,
    },

    competition: {
      view: exec === undefined ? null : readable(exec.competitivePosition),
      doNothing: m02 === undefined ? null : readable(m02.doNothing),
      competitors: (m02?.competitors ?? []).map((competitor, index) => ({
        key: `competitor-${index}`,
        name: competitor.name,
        ...(competitor.url === undefined ? {} : { url: competitor.url }),
        positioning: readable(competitor.positioning),
        pricing: competitor.pricing === undefined ? null : readable(competitor.pricing),
        pricingGated: competitor.pricingGated,
        strengths: competitor.strengths.map(readable),
        weaknesses: competitor.weaknesses.map(readable),
        recentMoves: competitor.recentMoves.map(cleanItem),
      })),
      prices: (m02?.pricingTable ?? []).map((row, index) => ({ key: `price-${index}`, ...row })),
      adjacent: (m02?.adjacent ?? []).map((entry, index) => ({ key: `adjacent-${index}`, name: entry.name, note: readable(entry.note) })),
    },

    companies: {
      groups: seedFirmsByGroup(pack)
        .slice()
        .sort((a, b) => (place.get(a.archetypeId) ?? Number.MAX_SAFE_INTEGER) - (place.get(b.archetypeId) ?? Number.MAX_SAFE_INTEGER))
        .map(({ archetypeId, groupName: name, firms }) => {
          const targeting = m04?.perArchetype.find((entry) => entry.archetypeId === archetypeId);
          return {
            key: `group-${place.get(archetypeId) ?? name}`,
            name,
            firms: firms.map((firm) => ({
              ...firm,
              signal: cleanItem(firm.signal),
              size: { ...firm.size, ...(firm.size.value === undefined ? {} : { value: readable(firm.size.value) }) },
            })),
            signs: (targeting?.triggerTaxonomy ?? []).map((row, index) => ({
              key: `sign-${index}`,
              text: readable(row.signal),
              strength: row.strength,
              whereToFind: readable(row.whereToFind),
              ...(row.url === undefined ? {} : { url: row.url }),
            })),
            recipe: {
              titles: [...(targeting?.recipe.titles ?? [])],
              excludeTitles: [...(targeting?.recipe.excludeTitles ?? [])],
              sizeMin: targeting?.recipe.sizeBand.min ?? 0,
              sizeMax: targeting?.recipe.sizeBand.max ?? 0,
              countries: [...(targeting?.recipe.countries ?? [])],
              industries: [...(targeting?.recipe.industries ?? [])],
              triggers: [...(targeting?.recipe.triggers ?? [])],
              locations: [...(targeting?.recipe.locations ?? [])],
            },
            listSources: (targeting?.listSources ?? []).map((source, index) => ({
              key: `list-${index}`,
              name: source.name,
              url: source.url,
              ...(source.note === undefined ? {} : { note: readable(source.note) }),
            })),
          };
        }),
    },

    gather: {
      kinds: GATHER_ORDER.flatMap((kind) => {
        const entries = (m10?.entries ?? [])
          .filter((entry) => entry.kind === kind)
          .map((entry) => {
            const day = entry.date?.slice(0, 10) ?? null;
            return {
              key: entry.id,
              name: entry.name,
              url: entry.url,
              date: entry.date ?? null,
              onTimeline: day !== null && eventDays.some((event) => event.date === day && event.host === hostOf(entry.url)),
              audience: readable(entry.audience),
              why: readable(entry.why),
              groups: (entry.archetypeIds ?? []).flatMap((id) => {
                const name = groupName(pack, id);
                return name === undefined ? [] : [name];
              }),
            };
          });
        return entries.length === 0 ? [] : [{ kind, entries }];
      }),
      discovery: (m02?.discoveryChannels ?? []).map(readable),
    },

    contact: {
      channels: (() => {
        const rules = m12?.rules ?? [];
        const order = [...new Set(["email", "linkedin", ...rules.map((rule) => rule.channel.toLowerCase())])];
        return order.flatMap((channel) => {
          const own = rules
            .filter((rule) => rule.channel.toLowerCase() === channel)
            .map((rule) => ({ key: rule.id, rule: readable(rule.rule), region: rule.region, source: rule.source, bars: rule.bars }));
          return own.length === 0 ? [] : [{ channel, rules: own }];
        });
      })(),
    },

    gaps: {
      groups: GAP_ORDER.flatMap((kind) => {
        const findings: ResearchFinding[] = [
          ...researchGaps(pack)
            .filter((gap) => GAP_GROUP[gap.kind] === kind)
            .map((gap): ResearchFinding => ({
              kind: "gap",
              gap: cleanGap(gap),
            })),
          ...researchContradictions(pack)
            .filter((entry) => (entry.kind === "disagree" ? "conflict" : "careful") === kind)
            .map((entry): ResearchFinding => ({
              kind: "contradiction",
              contradiction: cleanContradiction(entry),
            })),
        ];
        return findings.length === 0 ? [] : [{ kind, findings }];
      }),
    },

    sourceList: (completeModule(pack, "m19")?.sources ?? []).map((source) => ({ title: source.title, url: source.url, accessedAt: source.accessedAt })),
  };
}
