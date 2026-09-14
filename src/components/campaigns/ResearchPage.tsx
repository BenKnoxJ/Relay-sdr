import Link from "next/link";

import { PageHeader } from "@/components/PageHeader";
import type { CampaignResearch, PainRef, ResearchFinding, ResearchPart, TimelineEntry } from "@/lib/campaigns/types";
import { campaignsCopy, startCopy } from "@/lib/copy/campaigns";
import { researchCopy } from "@/lib/copy/research";
import { cn } from "@/lib/utils";

import { ConfidenceChip, PackItem, PackPhrase, WithHosts, packDate, shortDate, sourceHost } from "./PackItem";
import { PrintPack } from "./PrintPack";
import { ResearchNav } from "./ResearchNav";

/**
 * "What Relay learned" (task 19): everything research found for a campaign,
 * on one page, in eleven anchored parts.
 *
 * A server component with no state of its own. Each of the eleven parts is
 * closed by default and says what it holds; the longer lists inside open in
 * place (`<details>`). The one piece that runs in the browser is the
 * navigation (`ResearchNav`): anchors to each part, and Expand all / Collapse
 * all. Nothing here asks anything of the server. Every string of research's is shown as research
 * wrote it (`research.ts` takes out internal names and nothing else); a url is
 * only ever where a link goes, never text on the page.
 *
 * The eleven parts are drawn through a `Kit`, so the printed pack
 * (`ResearchReport`, task 20) draws the same parts from the same research,
 * laid out for paper. On paper this page is hidden and the pack is shown.
 */

/** The sources shown before "Show all". */
const SOURCES_FIRST = 10;

const CHANNELS: Record<string, string> = {
  email: startCopy.channelEmail,
  linkedin: startCopy.channelLinkedin,
  calls: startCopy.channelCalls,
};

const channelList = (channels: readonly string[]) => channels.map((channel) => CHANNELS[channel] ?? channel).join(", ");
const country = (code: string) => (campaignsCopy.countries as Record<string, string>)[code] ?? code;
const painAnchor = (ref: PainRef) => `pain-${ref.group}-${ref.pain}`;

/**
 * How a part and the lists inside it are laid out. The page opens and closes
 * them (`WEB`); the printed pack (`ResearchReport`) lays every one of them out
 * in full, with nothing to open. The parts themselves are the same code either
 * way, so the paper and the screen cannot disagree about what research found.
 */
export type Kit = {
  print: boolean;
  Part: (props: { part: ResearchPart; research: CampaignResearch; empty: boolean; children: React.ReactNode }) => React.ReactNode;
  More: (props: { label: string; testId: string; children: React.ReactNode }) => React.ReactNode;
  Group: (props: { name: string; open: boolean; testId: string; meta?: string; children: React.ReactNode }) => React.ReactNode;
  /** An id on this page. The pack prints beside the page, so its ids are its own. */
  id: (id: string) => string;
};

type SectionProps = { research: CampaignResearch; kit: Kit };

/** Opens more of the same part in place. The label reads "Show …" closed and "Hide …" open, with no script. */
function More({ label, testId, children }: { label: string; testId: string; children: React.ReactNode }) {
  return (
    <details data-testid={testId} className="mt-2 min-w-0">
      <summary className="type-small inline-flex min-h-6 cursor-pointer list-none items-center gap-1 rounded-pill font-semibold text-action focus-visible:outline-none focus-visible:ring-2 [&::-webkit-details-marker]:hidden">
        <span className="[details[open]>summary>&]:hidden">{researchCopy.show}</span>
        <span className="hidden [details[open]>summary>&]:inline">{researchCopy.hide}</span>
        <span>{label}</span>
      </summary>
      <div className="mt-1.5 min-w-0">{children}</div>
    </details>
  );
}

function Sub({ children, className }: { children: React.ReactNode; className?: string }) {
  return <h3 className={cn("type-label mb-1.5 mt-4 first:mt-0 print:break-after-avoid", className)}>{children}</h3>;
}

/**
 * One kind of buyer inside a part. The first, research's rank 1, is open; the
 * others open in place, so a part reads as one group at a time.
 */
function GroupBlock({ name, open, testId, meta, children }: { name: string; open: boolean; testId: string; meta?: string; children: React.ReactNode }) {
  return (
    <details open={open} data-testid={testId} className="min-w-0 rounded-input border border-line p-3">
      <summary className="flex cursor-pointer list-none flex-wrap items-baseline gap-x-3 rounded-input focus-visible:outline-none focus-visible:ring-2 [&::-webkit-details-marker]:hidden">
        <h3 className="type-name min-w-0 flex-1">{name}</h3>
        <span className="type-small shrink-0 font-semibold text-action">
          <span className="[details[open]>summary>span>&]:hidden">{researchCopy.show}</span>
          <span className="hidden [details[open]>summary>span>&]:inline">{researchCopy.hide}</span>
        </span>
        {meta === undefined ? null : <span className="type-small basis-full text-muted">{meta}</span>}
      </summary>
      <div className="mt-2 min-w-0">{children}</div>
    </details>
  );
}

function Lines({ lines, testId }: { lines: readonly string[]; testId?: string }) {
  return (
    <ul className="grid gap-1.5">
      {lines.map((line, index) => (
        <li key={index} data-testid={testId} className="type-small">
          <WithHosts text={line} />
        </li>
      ))}
    </ul>
  );
}

function HostLink({ url, children }: { url: string; children?: React.ReactNode }) {
  return (
    <a href={url} target="_blank" rel="noreferrer" className="underline focus-visible:outline-none focus-visible:ring-2">
      {children ?? sourceHost(url)}
    </a>
  );
}

export const count = (n: number, [one, many]: readonly [string, string]) => `${n} ${n === 1 ? one : many}`;

/**
 * What a closed part says about itself: counts of what it holds, read off the
 * same data the part draws when it opens. Nothing is summarised; a count is a
 * count.
 */
export function previewOf(part: ResearchPart, research: CampaignResearch): { text: string; warn?: boolean }[] {
  const p = researchCopy.preview;
  const groups = (n: number) => `${p.across} ${count(n, p.groups)}`;
  switch (part) {
    case "market": {
      const coming = research.market.timeline.filter((entry) => entry.comingUp === true);
      const next = coming[0]?.date;
      return [
        ...(research.market.timeline.length === 0 ? [] : [{ text: count(research.market.timeline.length, p.moments) }]),
        ...(coming.length === 0 ? [] : [{ text: `${coming.length} ${p.comingUp}${next === undefined || next === null ? "" : `, ${p.nextOn} ${packDate(next)}`}` }]),
        ...(research.market.segments.length === 0 ? [] : [{ text: count(research.market.segments.length, p.segments) }]),
      ];
    }
    case "who": {
      const b = research.who.boundaries;
      const lines = (b === null ? 0 : b.geography.length + (b.size === null ? 0 : 1) + b.sectorsIn.length + b.sectorsOut.length + b.firmsOut.length + b.other.length) +
        research.who.groupBoundaries.reduce((sum, entry) => sum + entry.lines.length, 0);
      return [
        ...(research.who.groups.length === 0 ? [] : [{ text: count(research.who.groups.length, p.groups) }]),
        ...(research.who.disqualifiers.length === 0 ? [] : [{ text: count(research.who.disqualifiers.length, p.notAFit) }]),
        ...(lines === 0 ? [] : [{ text: count(lines, p.boundaries) }]),
      ];
    }
    case "pains": {
      const g = research.pains.groups;
      const pains = g.reduce((sum, group) => sum + group.pains.length, 0);
      return [
        { text: `${count(pains, p.pains)} ${groups(g.length)}` },
        { text: count(g.reduce((sum, group) => sum + group.buyerWords.length, 0), p.buyerPhrases) },
        { text: `${g.reduce((sum, group) => sum + group.otherVoices.length, 0)} ${p.fromOthers}` },
      ];
    }
    case "say": {
      const g = research.say.groups;
      return [
        { text: `${count(g.reduce((sum, group) => sum + group.angles.length, 0), p.angles)} ${groups(g.length)}` },
        { text: count(g.reduce((sum, group) => sum + group.doDont.length, 0), p.doDont) },
        { text: count(g.reduce((sum, group) => sum + group.vocabulary.length, 0), p.words) },
      ];
    }
    case "prove": {
      const answers = research.prove.groups.flatMap((group) => group.answers);
      const d = research.prove.dontClaim;
      return [
        { text: count(answers.filter((answer) => answer.strength === "direct").length, p.answered) },
        { text: `${answers.filter((answer) => answer.strength === "partial").length} ${p.partly}` },
        { text: `${research.prove.groups.reduce((sum, group) => sum + group.unanswered.length, 0)} ${p.cantAnswer}` },
        { text: count(research.prove.groups.reduce((sum, group) => sum + group.objections.length, 0), p.objections) },
        { text: count(d.lead.length + d.product.length + d.brand.length + d.imply.length + d.proof.length, p.dontClaim) },
      ];
    }
    case "competition": {
      const c = research.competition;
      return [
        { text: count(c.competitors.length, p.competitors) },
        ...(c.prices.length === 0 ? [] : [{ text: count(c.prices.length, p.prices) }]),
        ...(c.doNothing === null ? [] : [{ text: p.doNothing }]),
      ];
    }
    case "companies": {
      const g = research.companies.groups;
      const firms = g.flatMap((group) => group.firms);
      const unknown = firms.filter((firm) => firm.size.status === "unknown").length;
      return [{ text: `${count(firms.length, p.firms)} ${groups(g.length)}` }, ...(unknown === 0 ? [] : [{ text: `${unknown} ${p.sizeUnknown}` }])];
    }
    case "gather":
      return [
        ...research.gather.kinds.map(({ kind, entries }) => ({ text: count(entries.length, p.kinds[kind]) })),
        ...(research.gather.discovery.length === 0 ? [] : [{ text: count(research.gather.discovery.length, p.toolPlaces) }]),
      ];
    case "contact": {
      const channels = research.contact.channels;
      const rules = channels.flatMap((channel) => channel.rules);
      const names = channels.map(({ channel }) => (researchCopy.channels as Record<string, string>)[channel] ?? channel);
      const barring = rules.filter((rule) => rule.bars).length;
      const across = names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} ${p.and} ${names.at(-1)}`;
      return [{ text: `${count(rules.length, p.rules)} ${p.across} ${across}` }, ...(barring === 0 ? [] : [{ text: count(barring, p.restrict), warn: true }])];
    }
    case "gaps": {
      const findings = research.gaps.groups.flatMap((group) => group.findings);
      const gaps = findings.flatMap((finding) => (finding.kind === "gap" ? [finding.gap] : []));
      return [
        { text: count(gaps.length, p.gaps) },
        { text: count(findings.length - gaps.length, p.contradictions) },
        { text: count(gaps.filter((gap) => gap.askOnFirstCall !== undefined).length, p.questions) },
      ];
    }
    case "sources": {
      const read = research.researchedOn === null ? null : shortDate(research.researchedOn);
      return [{ text: count(research.sources, p.sources) }, ...(read === null ? [] : [{ text: `${p.readOn} ${read}` }])];
    }
  }
}

/** A part's preview as it is shown. A count of nothing is left out: on a run cut short, "0 objections" would read as a finding when the part was never written. */
export function previewSegments(part: ResearchPart, research: CampaignResearch): { text: string; warn?: boolean }[] {
  return previewOf(part, research).filter((segment) => !/^0\b/.test(segment.text));
}

/** What a part research did not write, or wrote only some of, says about it: in a rep's words, never the pack's own names. */
export function unwrittenNames(missing: readonly string[]): string {
  return missing.map((id) => (campaignsCopy.partNames as Record<string, string>)[id] ?? id).join(", ");
}

/**
 * One of the eleven parts. Closed by default: its title, what it holds, and
 * "View …". Opened, everything the part has, with its own groups and "Show"s
 * inside as before. A part research did not write says so whether it is open
 * or not, and one with nothing in it has nothing to open.
 */
function Part({ part, research, empty, children }: { part: ResearchPart; research: CampaignResearch; empty: boolean; children: React.ReactNode }) {
  const missing = research.unwritten[part];
  const names = unwrittenNames(missing);
  const preview = previewSegments(part, research);
  const label = researchCopy.viewLabels[part];
  return (
    <section
      id={part}
      data-testid={`research-${part}`}
      aria-labelledby={`${part}-title`}
      className="min-w-0 scroll-mt-4 rounded-card border border-line bg-panel p-card shadow-card [overflow-wrap:anywhere]"
    >
      <h2 id={`${part}-title`} className="type-heading">
        {researchCopy.parts[part]}
      </h2>
      {missing.length === 0 ? null : (
        <p data-testid="part-unwritten" className="type-small mt-2 rounded-input bg-warn-bg px-3 py-2.5 text-warn">
          {empty ? researchCopy.unwrittenAll : `${researchCopy.unwrittenSome} ${names}.`}
        </p>
      )}
      {empty ? (
        missing.length === 0 ? (
          <p className="type-small mt-1.5 text-muted">{researchCopy.nothingHere}</p>
        ) : null
      ) : (
        <details data-research-section={part} data-testid={`section-${part}`} className="mt-1.5 min-w-0">
          <summary className="flex cursor-pointer list-none flex-wrap items-baseline gap-x-3 gap-y-1 rounded-input focus-visible:outline-none focus-visible:ring-2 [&::-webkit-details-marker]:hidden">
            <span data-testid="section-preview" className="type-small min-w-0 basis-full text-muted wide:flex-1 wide:basis-0">
              {preview.map((segment, index) => (
                <span key={index} className={segment.warn === true ? "font-semibold text-warn" : undefined}>
                  {index === 0 ? null : campaignsCopy.noteJoin}
                  {segment.text}
                </span>
              ))}
            </span>
            <span data-testid="section-toggle" className="type-small font-semibold text-action wide:shrink-0">
              <span className="[details[open]>summary>span>&]:hidden">
                {researchCopy.view} {label}
              </span>
              <span className="hidden [details[open]>summary>span>&]:inline">
                {researchCopy.hide} {label}
              </span>
            </span>
          </summary>
          <div className="mt-4 min-w-0">{children}</div>
        </details>
      )}
    </section>
  );
}

function PainLink({ research, pain, kit }: { research: CampaignResearch; pain: PainRef | null; kit: Kit }) {
  if (pain === null) return null;
  const group = research.who.groups[pain.group - 1]?.name;
  return (
    <a href={`#${kit.id(painAnchor(pain))}`} className="font-semibold text-action underline focus-visible:outline-none focus-visible:ring-2">
      {researchCopy.painWord} {pain.pain}
      {group === undefined ? null : `, ${group}`}
    </a>
  );
}

// ---------------------------------------------------------------------------

function TimelineRow({ entry, kit }: { entry: TimelineEntry; kit: Kit }) {
  const date = entry.date === null ? researchCopy.undated : packDate(entry.date);
  return (
    <li data-testid="timeline-entry" className="grid min-w-0 gap-x-3 border-t border-line py-2 first:border-t-0 wide:grid-cols-[7.5rem_minmax(0,1fr)] print:grid-cols-[7.5rem_minmax(0,1fr)]">
      <span data-testid="timeline-date" className="type-mono text-13 text-muted">
        {date}
      </span>
      {entry.kind === "trigger" ? (
        <div className="min-w-0">
          <PackItem item={entry.item} withQuote />
        </div>
      ) : (
        <div className="min-w-0">
          <p className="type-small">{entry.what}</p>
          <p className="type-small text-muted">{entry.why}</p>
          <p className="type-small text-muted">
            <HostLink url={entry.source} />
          </p>
          {entry.alsoReported.length === 0 ? null : (
            <kit.More label={`${entry.alsoReported.length} ${researchCopy.alsoReported}`} testId="also-reported">
              {entry.alsoReported.map((item) => (
                <PackItem key={item.id} item={item} withQuote />
              ))}
            </kit.More>
          )}
        </div>
      )}
    </li>
  );
}

function Market({ research, kit }: SectionProps) {
  const m = research.market;
  const past = m.timeline.filter((entry) => entry.comingUp !== true);
  const coming = m.timeline.filter((entry) => entry.comingUp === true);
  const split = m.timeline.some((entry) => entry.comingUp !== null);
  const empty = m.theCase === null && m.timeline.length === 0 && m.alsoExpected.length === 0 && m.segments.length === 0 && m.size.length === 0 && m.measures.length === 0 && m.bodies.length === 0;
  return (
    <kit.Part part="market" research={research} empty={empty}>
      {m.theCase === null ? null : (
        <>
          <Sub>{researchCopy.theCase}</Sub>
          <p className="type-body">{m.theCase}</p>
        </>
      )}
      {m.timeline.length === 0 && m.alsoExpected.length === 0 ? null : (
        <div data-testid="timeline" className="mt-4 first:mt-0">
          <Sub>{researchCopy.timelineLabel}</Sub>
          {research.researchedOn === null || !split ? null : (
            <p className="type-small mb-1.5 text-muted">
              {researchCopy.asOf} {shortDate(research.researchedOn)}, {researchCopy.asOfTail}
            </p>
          )}
          {split ? (
            <>
              <p className="type-small mt-2 font-semibold">{researchCopy.alreadyHappened}</p>
              <ol>{past.map((entry) => <TimelineRow key={entry.key} entry={entry} kit={kit} />)}</ol>
              {coming.length === 0 ? null : (
                <>
                  <p className="type-small mt-3 font-semibold">{researchCopy.comingUp}</p>
                  <ol>{coming.map((entry) => <TimelineRow key={entry.key} entry={entry} kit={kit} />)}</ol>
                </>
              )}
            </>
          ) : (
            <ol>{m.timeline.map((entry) => <TimelineRow key={entry.key} entry={entry} kit={kit} />)}</ol>
          )}
          {m.alsoExpected.length === 0 ? null : (
            <>
              <p className="type-small mt-3 font-semibold">{researchCopy.alsoExpected}</p>
              <Lines lines={m.alsoExpected} testId="also-expected" />
            </>
          )}
        </div>
      )}
      {m.segments.length === 0 ? null : (
        <>
          <Sub>{researchCopy.segmentsLabel}</Sub>
          <ul className="grid gap-chips wide:grid-cols-2 print:grid-cols-2">
            {m.segments.map((segment) => (
              <li key={segment.key} data-testid="market-segment" className="min-w-0 break-inside-avoid rounded-input border border-line bg-ground p-3">
                <p className="type-small font-semibold">{segment.name}</p>
                <p className={cn("type-small", segment.fit === "OUT" ? "text-warn" : segment.fit === "HIGH" ? "text-action" : "text-muted")}>
                  {researchCopy.fit[segment.fit]}
                  {segment.sizeRange === undefined ? null : <span className="text-muted">{`${campaignsCopy.noteJoin}${segment.sizeRange}`}</span>}
                </p>
                <p className="type-small mt-1">{segment.why}</p>
                {segment.countEstimate === undefined ? null : (
                  <p className="type-small mt-1 text-muted">
                    {researchCopy.segmentCount} {segment.countEstimate}
                  </p>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
      {m.size.length === 0 ? null : (
        <>
          <Sub>{researchCopy.sizeLabel}</Sub>
          <Lines lines={m.size} />
        </>
      )}
      {m.measures.length === 0 ? null : (
        <kit.More label={researchCopy.measuresLabel} testId="market-measures">
          <Lines lines={m.measures} />
        </kit.More>
      )}
      {m.bodies.length === 0 ? null : (
        <kit.More label={researchCopy.bodiesLabel} testId="market-bodies">
          <ul className="grid gap-2">
            {m.bodies.map((body) => (
              <li key={body.key} className="type-small">
                <span className="font-semibold">{body.name}</span>
                {body.url === undefined ? null : (
                  <span className="text-muted">
                    {" "}
                    <HostLink url={body.url} />
                  </span>
                )}
                <span className="block text-muted">{body.role}</span>
                <span className="block">{body.relevance}</span>
              </li>
            ))}
          </ul>
        </kit.More>
      )}
    </kit.Part>
  );
}

function Who({ research, kit }: SectionProps) {
  const w = research.who;
  const c = campaignsCopy;
  const empty = w.intro === null && w.groups.length === 0 && w.boundaries === null && w.idealCompany.length === 0 && w.idealBuyer.length === 0 && w.disqualifiers.length === 0;
  return (
    <kit.Part part="who" research={research} empty={empty}>
      {w.intro === null ? null : <p className="type-body mb-2">{w.intro}</p>}
      {w.groups.length === 0 ? null : (
        <>
          <p className="type-small mb-2 text-muted">{c.groupsNote}</p>
          <div className="grid gap-chips">
            {w.groups.map((group, index) => {
              const extra = w.groupBoundaries.find((entry) => entry.group === index + 1)?.lines ?? [];
              return (
                <kit.Group
                  key={group.key}
                  name={group.name}
                  open={index === 0}
                  testId="research-group"
                  meta={`${group.rank === null ? "" : `${researchCopy.ranked} ${group.rank} ${researchCopy.rankedOf} ${w.groups.length}${c.noteJoin}`}${c.groupSize} ${group.sizeRange}`}
                >
                  <p className="type-small">{group.situation}</p>
                  <Sub className="mt-3">{researchCopy.dominantPain}</Sub>
                  <PackItem item={group.dominantPain} withQuote />
                  {group.whyNow === null && group.wrongIf === null ? null : (
                    <dl className="mt-1.5 grid grid-cols-1 gap-x-3 gap-y-1 wide:grid-cols-[auto_minmax(0,1fr)] print:grid-cols-[auto_minmax(0,1fr)]">
                      {(
                        [
                          [c.startWhyNow, group.whyNow],
                          [c.startWrongIf, group.wrongIf],
                        ] as [string, string | null][]
                      ).map(([label, value]) =>
                        value === null ? null : (
                          <div key={label} className="contents">
                            <dt className="type-small font-semibold">{label}</dt>
                            <dd className="type-small min-w-0">{value}</dd>
                          </div>
                        ),
                      )}
                    </dl>
                  )}
                  <Sub className="mt-3">{researchCopy.involved}</Sub>
                  <ul className="grid gap-1.5">
                    {group.roles.map((role, roleIndex) => (
                      <li key={roleIndex} data-testid="group-role" className="type-small">
                        <span className="font-semibold">{c.roleParts[role.part]}:</span> {role.title}
                        <span className="text-muted"> ({role.seniority})</span>
                        <span className="block text-muted">
                          {researchCopy.needs} {role.needs}
                        </span>
                      </li>
                    ))}
                  </ul>
                  <kit.More label={researchCopy.deal} testId="group-deal">
                    <div className="flex items-start gap-2.5">
                      <ConfidenceChip confidence={group.deal.confidence} />
                      <dl className="grid min-w-0 grid-cols-1 gap-x-3 gap-y-1 wide:grid-cols-[auto_minmax(0,1fr)] print:grid-cols-[auto_minmax(0,1fr)]">
                        {(Object.keys(researchCopy.dealFields) as (keyof typeof researchCopy.dealFields)[]).map((field) =>
                          group.deal[field] === undefined ? null : (
                            <div key={field} className="contents">
                              <dt className="type-small font-semibold">{researchCopy.dealFields[field]}</dt>
                              <dd className="type-small min-w-0">{group.deal[field]}</dd>
                            </div>
                          ),
                        )}
                      </dl>
                    </div>
                    {group.deal.note === undefined ? null : <p className="type-small mt-1.5 text-muted">{group.deal.note}</p>}
                  </kit.More>
                  {extra.length === 0 ? null : (
                    <>
                      <Sub className="mt-3">
                        {researchCopy.groupBoundaries} {group.name}
                      </Sub>
                      <Lines lines={extra} testId="boundary" />
                    </>
                  )}
                </kit.Group>
              );
            })}
          </div>
        </>
      )}
      {w.idealCompany.length === 0 ? null : (
        <>
          <Sub>{researchCopy.idealCompany}</Sub>
          <Lines lines={w.idealCompany} />
        </>
      )}
      {w.idealBuyer.length === 0 ? null : (
        <>
          <Sub>{researchCopy.idealBuyer}</Sub>
          <Lines lines={w.idealBuyer} />
        </>
      )}
      {w.disqualifiers.length === 0 ? null : (
        <>
          <Sub>{researchCopy.notAFit}</Sub>
          <ul className="grid gap-1.5">
            {w.disqualifiers.map((entry, index) => (
              <li key={index} data-testid="disqualifier" className="type-small break-inside-avoid">
                <span className="font-semibold">{entry.who}</span>
                <span className="block text-muted">{entry.why}</span>
              </li>
            ))}
          </ul>
        </>
      )}
      {w.boundaries === null ? null : (
        <div data-testid="boundaries">
          <Sub>{researchCopy.boundariesLabel}</Sub>
          <p className="type-small mb-1.5 text-muted">{researchCopy.boundariesNote}</p>
          <dl className="grid grid-cols-1 gap-x-3 gap-y-1.5 wide:grid-cols-[auto_minmax(0,1fr)] print:grid-cols-[auto_minmax(0,1fr)]">
            {(
              [
                ["geography", w.boundaries.geography],
                ["size", w.boundaries.size === null ? [] : [w.boundaries.size]],
                ["sectorsIn", w.boundaries.sectorsIn],
                ["sectorsOut", w.boundaries.sectorsOut],
                ["firmsOut", w.boundaries.firmsOut],
                ["other", w.boundaries.other],
              ] as [keyof typeof researchCopy.boundaryLabels, string[]][]
            ).map(([field, lines]) =>
              lines.length === 0 ? null : (
                <div key={field} className="contents">
                  <dt className="type-small font-semibold">{researchCopy.boundaryLabels[field]}</dt>
                  <dd className="min-w-0">
                    <Lines lines={lines} testId="boundary" />
                  </dd>
                </div>
              ),
            )}
          </dl>
        </div>
      )}
    </kit.Part>
  );
}

/**
 * How many of a group's phrases are buyers' own and how many are others'. A
 * count of nothing is left out, as in a part's preview: on a run cut short
 * before buyers' words were written, "0 in buyers' own words" would read as a
 * finding.
 */
function groupVoices(group: CampaignResearch["pains"]["groups"][number]): string | undefined {
  const counts = [
    [group.buyerWords.length, researchCopy.buyerCount],
    [group.otherVoices.length, researchCopy.otherCount],
  ] as const;
  const shown = counts.filter(([n]) => n > 0).map(([n, label]) => `${n} ${label}`);
  return shown.length === 0 ? undefined : shown.join(campaignsCopy.noteJoin);
}

function Pains({ research, kit }: SectionProps) {
  const c = campaignsCopy;
  return (
    <kit.Part part="pains" research={research} empty={research.pains.groups.length === 0}>
      <div className="grid gap-chips">
        {research.pains.groups.map((group) => {
          const place = Number(group.key.replace("group-", ""));
          return (
            <kit.Group
              key={group.key}
              name={group.name}
              open={place === 1}
              testId="pain-group"
              meta={groupVoices(group)}
            >
              {group.pains.length === 0 ? null : (
                <>
                  <Sub>{researchCopy.painsLabel}</Sub>
                  <ol className="grid">
                    {group.pains.map((pain, index) => (
                      <li key={pain.id} id={kit.id(painAnchor({ group: place, pain: index + 1 }))} data-testid="research-pain" className="flex scroll-mt-4 gap-2">
                        <span className="type-mono pt-2 text-13 text-muted">{index + 1}.</span>
                        <div className="min-w-0 flex-1">
                          <PackItem item={pain} withQuote />
                        </div>
                      </li>
                    ))}
                  </ol>
                </>
              )}
              <Sub className="mt-3">{c.buyerWordsLabel}</Sub>
              <div data-testid="buyer-words">
                {group.buyerWords.length === 0 ? (
                  <p className="type-small text-muted">{c.noBuyerWords}</p>
                ) : (
                  group.buyerWords.map((phrase) => <PackPhrase key={phrase.id} phrase={phrase} />)
                )}
              </div>
              {group.otherVoices.length === 0 ? null : (
                <div data-testid="other-voices" className="mt-2 rounded-input border border-line bg-ground p-3">
                  <p className="type-label mb-1">{researchCopy.otherVoicesLabel}</p>
                  {group.otherVoices.map(({ voice, phrase }) => (
                    <div key={phrase.id} data-testid="other-voice">
                      <p className="type-small font-semibold text-muted">{researchCopy.voices[voice]}</p>
                      <PackPhrase phrase={phrase} />
                    </div>
                  ))}
                </div>
              )}
            </kit.Group>
          );
        })}
      </div>
    </kit.Part>
  );
}

function Say({ research, kit }: SectionProps) {
  const s = research.say;
  return (
    <kit.Part part="say" research={research} empty={s.groups.length === 0 && s.intro === null}>
      {s.intro === null ? null : (
        <>
          <Sub>{researchCopy.position}</Sub>
          <p className="type-body">{s.intro}</p>
        </>
      )}
      <div className="mt-4 grid gap-chips">
        {s.groups.map((group, index) => (
          <kit.Group key={group.key} name={group.name} open={index === 0} testId="say-group">
            {group.angles.length === 0 ? null : (
              <>
                <Sub>{researchCopy.anglesLabel}</Sub>
                <ol className="grid gap-2">
                  {group.angles.map((angle) => (
                    <li
                      key={angle.key}
                      data-testid="research-angle"
                      className={cn("min-w-0 break-inside-avoid rounded-input p-3", angle.lead ? "border border-action bg-soft" : "border border-line")}
                    >
                      {angle.lead ? <p className="type-label mb-1 text-action">{researchCopy.leadWith}</p> : null}
                      <p className="type-small">{angle.text}</p>
                      <p className="type-small mt-1 flex flex-wrap items-center gap-2 text-muted">
                        {angle.confidence === null ? null : <ConfidenceChip confidence={angle.confidence} />}
                        <span>
                          {researchCopy.suits} {channelList(angle.channels)}
                        </span>
                      </p>
                    </li>
                  ))}
                </ol>
              </>
            )}
            {group.doDont.length === 0 ? null : (
              <>
                <Sub className="mt-3">{researchCopy.doDontLabel}</Sub>
                <ul className="grid gap-2">
                  {group.doDont.map((row, index) => (
                    <li key={index} className="type-small">
                      <span className="block">
                        <span className="font-semibold">{researchCopy.doLabel}</span> {row.use}
                      </span>
                      <span className="block">
                        <span className="font-semibold text-warn">{researchCopy.dontLabel}</span> {row.avoid}
                      </span>
                      {row.why === undefined ? null : (
                        <span className="block text-muted">
                          {researchCopy.whyLabel} {row.why}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              </>
            )}
            {group.verbatim.length === 0 ? null : (
              <>
                <Sub className="mt-3">{researchCopy.verbatimLabel}</Sub>
                {group.verbatim.map((line) => (
                  <PackItem key={line.id} item={line} quoteFirst />
                ))}
              </>
            )}
            {group.vocabulary.length === 0 ? null : (
              <>
                <Sub className="mt-3">{researchCopy.vocabularyLabel}</Sub>
                <ul className="flex flex-wrap gap-1.5">
                  {group.vocabulary.map((word) => (
                    <li key={word} className="type-small rounded-pill border border-line bg-ground px-2.5 py-0.5">
                      {word}
                    </li>
                  ))}
                </ul>
              </>
            )}
          </kit.Group>
        ))}
      </div>
    </kit.Part>
  );
}

function Prove({ research, kit }: SectionProps) {
  const p = research.prove;
  const d = p.dontClaim;
  const dontCount = d.lead.length + d.product.length + d.brand.length + d.imply.length + d.proof.length;
  return (
    <kit.Part part="prove" research={research} empty={p.groups.length === 0 && p.proof.length === 0 && dontCount === 0}>
      <div className="grid gap-chips">
        {p.groups.map((group, index) => (
          <kit.Group key={group.key} name={group.name} open={index === 0} testId="prove-group">
            {group.answers.length === 0 ? null : (
              <>
                <Sub>{researchCopy.answersLabel}</Sub>
                <ul className="grid gap-2">
                  {group.answers.map((answer) => (
                    <li key={answer.key} data-testid="research-answer" className="type-small break-inside-avoid">
                      <span className="block text-muted">
                        <PainLink research={research} kit={kit} pain={answer.pain} />
                        {answer.pain === null ? null : campaignsCopy.noteJoin}
                        <span className={answer.strength === "direct" ? "text-action" : "text-warn"}>{researchCopy.strength[answer.strength]}</span>
                        {answer.strength === "partial" ? (
                          <>
                            {campaignsCopy.noteJoin}
                            <a href={`#${kit.id("dont-claim")}`} className="underline focus-visible:outline-none focus-visible:ring-2">
                              {researchCopy.seeLimits}
                            </a>
                          </>
                        ) : null}
                      </span>
                      {answer.capability}
                    </li>
                  ))}
                </ul>
              </>
            )}
            {group.unanswered.length === 0 ? null : (
              <>
                <Sub className="mt-3">{researchCopy.unansweredLabel}</Sub>
                <ul className="grid gap-2">
                  {group.unanswered.map((entry) => (
                    <li key={entry.key} data-testid="research-unanswered" className="type-small break-inside-avoid">
                      <span className="block">
                        <PainLink research={research} kit={kit} pain={entry.pain} />
                      </span>
                      <span className="block text-muted">{entry.status}</span>
                      {entry.note === undefined ? null : <span className="block">{entry.note}</span>}
                    </li>
                  ))}
                </ul>
              </>
            )}
            {group.objections.length === 0 ? null : (
              <>
                <Sub className="mt-3">{researchCopy.objectionsLabel}</Sub>
                <ul className="grid gap-2">
                  {group.objections.map((objection) => (
                    <li key={objection.key} data-testid="research-objection" className="type-small break-inside-avoid">
                      <span className="block font-semibold">“{objection.objection}”</span>
                      {objection.notToday ? <span className="mr-1.5 font-semibold text-warn">{researchCopy.notToday}.</span> : null}
                      {objection.answer === null ? <span className="text-muted">{researchCopy.noAnswer}</span> : objection.answer}
                    </li>
                  ))}
                </ul>
              </>
            )}
          </kit.Group>
        ))}
      </div>
      {p.proof.length === 0 ? null : (
        <>
          <Sub className="mt-5">{researchCopy.proofLabel}</Sub>
          <ul className="grid gap-2">
            {p.proof.map((proof) => (
              <li key={proof.key} data-testid="research-proof" className="type-small break-inside-avoid">
                {proof.text}
                {proof.note === undefined ? null : (
                  <span className="block text-muted">
                    {researchCopy.proofNote} {proof.note}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
      {dontCount === 0 ? null : (
        <div id={kit.id("dont-claim")} data-testid="dont-claim" className="mt-5 scroll-mt-4 rounded-input border border-warn bg-warn-bg p-3">
          <h3 className="type-name text-warn">{researchCopy.dontClaimLabel}</h3>
          <p className="type-small mb-2 text-muted">{researchCopy.dontClaimNote}</p>
          {(
            [
              [researchCopy.dontLead, d.lead],
              [researchCopy.dontProduct, d.product],
              [researchCopy.dontBrand, d.brand],
            ] as [string, readonly string[]][]
          ).map(([label, lines]) =>
            lines.length === 0 ? null : (
              <div key={label} className="mt-2">
                <p className="type-small font-semibold">{label}</p>
                <Lines lines={lines} testId="dont-claim-line" />
              </div>
            ),
          )}
          {d.imply.length === 0 ? null : (
            <div className="mt-2">
              <p className="type-small font-semibold">{researchCopy.dontImply}</p>
              <ul className="grid gap-1.5">
                {d.imply.map((entry) => (
                  <li key={entry.key} data-testid="dont-claim-line" className="type-small">
                    {entry.text}
                    {entry.pain === null ? null : (
                      <span className="block text-muted">
                        {researchCopy.forLabel} <PainLink research={research} kit={kit} pain={entry.pain} />
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {d.proof.length === 0 ? null : (
            <div className="mt-2">
              <p className="type-small font-semibold">{researchCopy.dontProof}</p>
              <ul className="grid gap-1.5">
                {d.proof.map((entry) => (
                  <li key={entry.key} data-testid="dont-claim-line" className="type-small">
                    {entry.text}
                    {entry.note === undefined ? null : <span className="block text-muted">{entry.note}</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </kit.Part>
  );
}

function Competition({ research, kit }: SectionProps) {
  const m = research.competition;
  const cols = researchCopy.priceCols;
  return (
    <kit.Part part="competition" research={research} empty={m.competitors.length === 0 && m.doNothing === null && m.view === null && m.prices.length === 0 && m.adjacent.length === 0}>
      {m.view === null ? null : (
        <>
          <Sub>{researchCopy.viewLabel}</Sub>
          <p className="type-body">{m.view}</p>
        </>
      )}
      {m.doNothing === null ? null : (
        <div data-testid="do-nothing" className="mt-4 rounded-input border border-line bg-ground p-3">
          <h3 className="type-name">{researchCopy.doNothingLabel}</h3>
          <p className="type-small mt-1">{m.doNothing}</p>
        </div>
      )}
      <div className="mt-4 grid gap-chips">
        {m.competitors.map((competitor) => (
          <article key={competitor.key} data-testid="competitor" className="min-w-0 rounded-input border border-line p-3">
            <h3 className="type-name">
              {competitor.name}
              {competitor.url === undefined ? null : (
                <span className="type-small ml-2 font-normal text-muted">
                  <HostLink url={competitor.url} />
                </span>
              )}
            </h3>
            <p className="type-small mt-1">{competitor.positioning}</p>
            <p className="type-small mt-1">
              <span className="font-semibold">{researchCopy.priceLabel}</span>{" "}
              {competitor.pricing ?? (competitor.pricingGated ? researchCopy.notPublished : null)}
            </p>
            <kit.More label={researchCopy.strengthsLabel} testId="competitor-more">
              <div className="grid gap-3 wide:grid-cols-2 print:grid-cols-2">
                <div className="min-w-0">
                  <p className="type-small font-semibold">{researchCopy.strongAt}</p>
                  <Lines lines={competitor.strengths} />
                </div>
                <div className="min-w-0">
                  <p className="type-small font-semibold">{researchCopy.weakAt}</p>
                  <Lines lines={competitor.weaknesses} />
                </div>
              </div>
            </kit.More>
            {competitor.recentMoves.length === 0 ? null : (
              <>
                <Sub className="mt-3">{researchCopy.recentMoves}</Sub>
                {competitor.recentMoves.map((move) => (
                  <PackItem key={move.id} item={move} />
                ))}
              </>
            )}
          </article>
        ))}
      </div>
      {m.prices.length === 0 ? null : (
        <kit.More label={researchCopy.pricesLabel} testId="competition-prices">
          <div className="overflow-x-auto print:overflow-visible">
            <table className="type-small w-full min-w-[32rem] border-collapse text-left print:min-w-0">
              <thead>
                <tr className="border-b border-line">
                  {[cols.name, cols.price, cols.minimum, cols.commitment].map((col) => (
                    <th key={col} scope="col" className={cn("py-1.5 pr-3 font-semibold", col === cols.name && "print:w-[30%]")}>
                      {col}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {m.prices.map((row) => (
                  <tr key={row.key} className="break-inside-avoid border-b border-line align-top">
                    <td className="py-1.5 pr-3 font-semibold">{row.name}</td>
                    <td className="py-1.5 pr-3">{row.price}</td>
                    <td className="py-1.5 pr-3">{row.minimum ?? ""}</td>
                    <td className="py-1.5 pr-3">{row.commitment ?? ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </kit.More>
      )}
      {m.adjacent.length === 0 ? null : (
        <kit.More label={researchCopy.adjacentLabel} testId="competition-adjacent">
          <ul className="grid gap-2">
            {m.adjacent.map((entry) => (
              <li key={entry.key} className="type-small">
                <span className="font-semibold">{entry.name}</span>
                <span className="block text-muted">{entry.note}</span>
              </li>
            ))}
          </ul>
        </kit.More>
      )}
    </kit.Part>
  );
}

function sizeLine(size: CampaignResearch["companies"]["groups"][number]["firms"][number]["size"]): string {
  if (size.status === "unknown" || size.value === undefined) return campaignsCopy.sizeUnknown;
  return `${size.value} (${size.status === "confirmed" ? campaignsCopy.sizeConfirmed : campaignsCopy.sizeEstimated})`;
}

function Companies({ research, kit }: SectionProps) {
  const c = campaignsCopy;
  return (
    <kit.Part part="companies" research={research} empty={research.companies.groups.length === 0}>
      <p className="type-small mb-3 text-muted">{c.firmsNote}</p>
      <div className="grid gap-chips">
        {research.companies.groups.map((group, index) => (
          <kit.Group
            key={group.key}
            name={group.name}
            open={index === 0}
            testId="company-group"
            meta={`${group.firms.length} ${group.firms.length === 1 ? c.countFirm : c.countFirms}`}
          >
            <ul className="grid gap-chips">
              {group.firms.map((firm) => (
                <li key={firm.id} data-testid="research-firm" className="min-w-0 break-inside-avoid rounded-input border border-line p-3">
                  <p className="type-small">
                    <span className="font-semibold">{firm.name}</span>
                    {firm.domain === undefined ? null : <span className="text-muted"> {sourceHost(`https://${firm.domain.replace(/^https?:\/\//, "")}`)}</span>}
                  </p>
                  <p className="type-small text-muted">
                    {[firm.orgType, firm.region].filter((part) => part !== undefined).join(c.noteJoin)}
                  </p>
                  <p data-testid="firm-size" className={cn("type-small", firm.size.status === "unknown" ? "text-warn" : "")}>
                    {sizeLine(firm.size)}
                    {/* An unknown size keeps research's note on why, never as a size. */}
                    {firm.size.status === "unknown" && firm.size.value !== undefined ? <span className="block text-muted">{firm.size.value}</span> : null}
                    {firm.size.source === undefined || firm.size.status === "unknown" ? null : (
                      <span className="text-muted">
                        {c.noteJoin}
                        {researchCopy.sizeFrom} <HostLink url={firm.size.source} />
                      </span>
                    )}
                  </p>
                  <p className="type-small mt-1.5 font-semibold">{researchCopy.fitsBecause}</p>
                  <PackItem item={firm.signal} />
                </li>
              ))}
            </ul>
            <kit.More label={researchCopy.findMore} testId="company-recipe">
              <dl className="grid grid-cols-1 gap-x-3 gap-y-1.5 wide:grid-cols-[auto_minmax(0,1fr)] print:grid-cols-[auto_minmax(0,1fr)]">
                <dt className="type-small font-semibold">{researchCopy.titlesLabel}</dt>
                <dd className="type-small min-w-0">{group.recipe.titles.join(", ")}</dd>
                {group.recipe.excludeTitles.length === 0 ? null : (
                  <>
                    <dt className="type-small font-semibold">{researchCopy.excludeLabel}</dt>
                    <dd className="type-small min-w-0">{group.recipe.excludeTitles.join(", ")}</dd>
                  </>
                )}
                <dt className="type-small font-semibold">{c.recipeWhere}</dt>
                <dd className="type-small min-w-0">{[...group.recipe.countries.map(country), ...group.recipe.locations].join(", ")}</dd>
                <dt className="type-small font-semibold">{c.recipeIndustry}</dt>
                <dd className="type-small min-w-0">{group.recipe.industries.join(", ")}</dd>
                <dt className="type-small font-semibold">{researchCopy.recipeSizeLabel}</dt>
                <dd className="type-small min-w-0">
                  {c.recipeSize} {group.recipe.sizeMin} {c.recipeAnd} {group.recipe.sizeMax}
                </dd>
                {group.recipe.triggers.length === 0 ? null : (
                  <>
                    <dt className="type-small font-semibold">{c.recipeTriggers}</dt>
                    <dd className="min-w-0">
                      <Lines lines={group.recipe.triggers} />
                    </dd>
                  </>
                )}
              </dl>
              {group.signs.length === 0 ? null : (
                <>
                  <Sub className="mt-3">{researchCopy.signsLabel}</Sub>
                  <ul className="grid gap-2">
                    {group.signs.map((sign) => (
                      <li key={sign.key} className="type-small">
                        <span className={cn("font-semibold", sign.strength === "HOT" ? "text-action" : "text-muted")}>{researchCopy.signStrength[sign.strength]}</span>
                        {c.noteJoin}
                        {sign.text}
                        <span className="block text-muted">
                          {researchCopy.whereToLook} {sign.whereToFind}
                          {sign.url === undefined ? null : (
                            <>
                              {c.noteJoin}
                              <HostLink url={sign.url} />
                            </>
                          )}
                        </span>
                      </li>
                    ))}
                  </ul>
                </>
              )}
              {group.listSources.length === 0 ? null : (
                <>
                  <Sub className="mt-3">{researchCopy.listSourcesLabel}</Sub>
                  <ul className="grid gap-2">
                    {group.listSources.map((source) => (
                      <li key={source.key} className="type-small">
                        <HostLink url={source.url}>{source.name}</HostLink>
                        <span className="text-muted"> {sourceHost(source.url)}</span>
                        {source.note === undefined ? null : <span className="block text-muted">{source.note}</span>}
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </kit.More>
          </kit.Group>
        ))}
      </div>
    </kit.Part>
  );
}

function Gather({ research, kit }: SectionProps) {
  const g = research.gather;
  const c = campaignsCopy;
  return (
    <kit.Part part="gather" research={research} empty={g.kinds.length === 0 && g.discovery.length === 0}>
      <div className="grid gap-4">
        {g.kinds.map(({ kind, entries }) => (
          <div key={kind} className="min-w-0">
            <h3 className="type-name">{researchCopy.kinds[kind]}</h3>
            <ul className="mt-1.5 grid gap-chips wide:grid-cols-2 print:grid-cols-2">
              {entries.map((entry) => (
                <li key={entry.key} data-testid="venue" className="min-w-0 break-inside-avoid rounded-input border border-line p-3">
                  <p className="type-small">
                    <HostLink url={entry.url}>
                      <span className="font-semibold">{entry.name}</span>
                    </HostLink>
                    <span className="text-muted"> {sourceHost(entry.url)}</span>
                  </p>
                  {entry.date === null ? null : (
                    <p data-testid="venue-date" className="type-small text-muted">
                      {packDate(entry.date)}
                      {entry.onTimeline ? (
                        <>
                          {c.noteJoin}
                          <a href={`#${kit.id("market")}`} data-testid="venue-on-timeline" className="underline focus-visible:outline-none focus-visible:ring-2">
                            {researchCopy.onTimeline}
                          </a>
                        </>
                      ) : null}
                    </p>
                  )}
                  <p className="type-small mt-1">{entry.why}</p>
                  <p className="type-small mt-1 text-muted">{entry.audience}</p>
                  {entry.groups.length === 0 ? null : (
                    <p className="type-small mt-1 text-muted">
                      {c.forGroup} {entry.groups.join(", ")}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      {g.discovery.length === 0 ? null : (
        <>
          <Sub className="mt-4">{researchCopy.discoveryLabel}</Sub>
          <Lines lines={g.discovery} />
        </>
      )}
    </kit.Part>
  );
}

function Contact({ research, kit }: SectionProps) {
  return (
    <kit.Part part="contact" research={research} empty={research.contact.channels.length === 0}>
      <p className="type-small mb-3 text-muted">{researchCopy.contactNote}</p>
      <div className="grid gap-4">
        {research.contact.channels.map(({ channel, rules }) => {
          const barring = rules.filter((rule) => rule.bars).length;
          return (
            <div key={channel} data-testid="contact-channel" className="min-w-0">
              <h3 className="type-name">
                {(researchCopy.channels as Record<string, string>)[channel] ?? channel}
                {barring === 0 ? null : (
                  <span data-testid="channel-restricted" className="type-small ml-2 font-semibold text-warn">
                    {barring} {barring === 1 ? researchCopy.restrictCountOne : researchCopy.restrictCountMany}
                  </span>
                )}
              </h3>
              <ul className="mt-1.5 grid gap-2">
                {rules.map((rule) => (
                  <li
                    key={rule.key}
                    data-testid="contact-rule"
                    data-bars={rule.bars ? "true" : "false"}
                    className={cn("type-small min-w-0 break-inside-avoid rounded-input p-3", rule.bars ? "border-2 border-warn bg-warn-bg" : "border border-line")}
                  >
                    {rule.bars ? <p className="type-label mb-1 text-warn">{researchCopy.restricts}</p> : null}
                    {rule.rule}
                    <span className="mt-1 block text-muted">
                      {researchCopy.whereLabel} {country(rule.region)}
                      {campaignsCopy.noteJoin}
                      <HostLink url={rule.source} />
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </div>
    </kit.Part>
  );
}

function Finding({ finding, kit }: { finding: ResearchFinding; kit: Kit }) {
  const c = campaignsCopy;
  if (finding.kind === "contradiction") {
    const { contradiction } = finding;
    return (
      <li data-testid="research-contradiction" className="min-w-0 break-inside-avoid border-t border-line py-2.5 first:border-t-0">
        <p className="type-small">
          <WithHosts text={contradiction.text} />
        </p>
        <p className="type-small mt-1">
          <span className="font-semibold">{c.meaningLabel}</span> {contradiction.meaning}
        </p>
        {contradiction.a === undefined ? null : <PackItem item={contradiction.a} />}
        {contradiction.b === undefined ? null : <PackItem item={contradiction.b} />}
      </li>
    );
  }
  const { gap } = finding;
  return (
    <li data-testid="research-gap" className="min-w-0 break-inside-avoid border-t border-line py-2.5 first:border-t-0">
      <p className="type-small">
        <WithHosts text={gap.text} />
      </p>
      <p className="type-small mt-1">
        <span className="text-muted">{c.whyItMatters}</span> {gap.whyItMatters}
      </p>
      {gap.askOnFirstCall === undefined ? null : (
        <p data-testid="gap-question" className="type-small mt-1">
          <span className="font-semibold">{c.askOnCall}</span> {gap.askOnFirstCall}
        </p>
      )}
      {/* What research searched is how it worked, not what it found: the page keeps it a click away, the pack leaves it out. */}
      {gap.queriesTried.length === 0 || kit.print ? null : (
        <kit.More label={researchCopy.searched} testId="gap-searched">
          <Lines lines={gap.queriesTried} testId="gap-query" />
        </kit.More>
      )}
    </li>
  );
}

function Gaps({ research, kit }: SectionProps) {
  return (
    <kit.Part part="gaps" research={research} empty={research.gaps.groups.length === 0}>
      <div className="grid gap-4">
        {research.gaps.groups.map(({ kind, findings }) => (
          <div key={kind} data-testid={`gap-group-${kind}`} className="min-w-0">
            <h3 className="type-name">{researchCopy.gapGroups[kind]}</h3>
            <ul>
              {findings.map((finding) => (
                <Finding key={finding.kind === "gap" ? finding.gap.id : finding.contradiction.id} finding={finding} kit={kit} />
              ))}
            </ul>
          </div>
        ))}
      </div>
    </kit.Part>
  );
}

/** One source. On paper, where a link cannot be followed, the address itself is printed under it, and wraps. */
function SourceRow({ source, n, print }: { source: CampaignResearch["sourceList"][number]; n: number; print: boolean }) {
  const read = shortDate(source.accessedAt);
  return (
    <li data-testid="research-source" className="type-small flex min-w-0 break-inside-avoid gap-2 py-1">
      <span className="type-mono w-8 shrink-0 text-right text-13 text-muted">{n}</span>
      <span className="min-w-0">
        <HostLink url={source.url}>{source.title}</HostLink>
        <span className="block text-muted">
          {sourceHost(source.url)}
          {read === null ? null : `${campaignsCopy.noteJoin}${researchCopy.readOn} ${read}`}
        </span>
        {print ? (
          <span data-testid="source-url" className="type-mono block text-11 text-muted [overflow-wrap:anywhere]">
            {source.url}
          </span>
        ) : null}
      </span>
    </li>
  );
}

function Sources({ research, kit }: SectionProps) {
  const list = research.sourceList;
  // The page shows the first few and the rest on request; the pack is the reference, so it lists them all.
  const first = kit.print ? list.length : SOURCES_FIRST;
  return (
    <kit.Part part="sources" research={research} empty={list.length === 0}>
      <ol>
        {list.slice(0, first).map((source, index) => (
          <SourceRow key={index} source={source} n={index + 1} print={kit.print} />
        ))}
      </ol>
      {list.length <= first ? null : (
        <kit.More label={`${researchCopy.showAllSources} ${list.length} ${researchCopy.metaSources}`} testId="sources-more">
          <ol>
            {list.slice(first).map((source, index) => (
              <SourceRow key={index} source={source} n={first + index + 1} print={kit.print} />
            ))}
          </ol>
        </kit.More>
      )}
    </kit.Part>
  );
}

/** The page's own way of laying out a part: closed, with its lists a click away. */
const WEB: Kit = { print: false, Part, More, Group: GroupBlock, id: (id) => id };

/** The eleven parts, in page order. The printed pack draws the same ones, in the same order. */
export const SECTIONS: { part: ResearchPart; Body: (props: SectionProps) => React.ReactNode }[] = [
  { part: "market", Body: Market },
  { part: "who", Body: Who },
  { part: "pains", Body: Pains },
  { part: "say", Body: Say },
  { part: "prove", Body: Prove },
  { part: "competition", Body: Competition },
  { part: "companies", Body: Companies },
  { part: "gather", Body: Gather },
  { part: "contact", Body: Contact },
  { part: "gaps", Body: Gaps },
  { part: "sources", Body: Sources },
];

// ---------------------------------------------------------------------------

export function ResearchPage({ name, campaignHref, research }: { name: string; campaignHref: string; research: CampaignResearch }) {
  const researched = research.researchedOn === null ? null : shortDate(research.researchedOn);
  return (
    // The page is for reading on screen. Printing it prints the pack beside it (`ResearchReport`) instead.
    <div data-testid="research" className="mx-auto grid min-w-0 max-w-[1120px] gap-grid wide:grid-cols-[12rem_minmax(0,1fr)] wide:items-start print:hidden">
      <ResearchNav placement="side" />
      <div className="grid min-w-0 gap-grid">
        <div className="min-w-0">
          <Link
            href={campaignHref}
            data-testid="research-back"
            className="type-small inline-flex min-h-6 items-center rounded-pill font-semibold text-action focus-visible:outline-none focus-visible:ring-2"
          >
            {researchCopy.back}
          </Link>
          <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
            <div className="min-w-0">
              <PageHeader title={researchCopy.title} className="mb-1 mt-2" />
              <p className="type-body text-muted [overflow-wrap:anywhere]">{name}</p>
              <p data-testid="research-meta" className="type-mono mt-1 text-13 text-muted">
                {research.sources} {research.sources === 1 ? researchCopy.metaSource : researchCopy.metaSources}
                {researched === null ? null : `${campaignsCopy.noteJoin}${researchCopy.metaResearched} ${researched}`}
              </p>
            </div>
            <PrintPack name={name} />
          </div>
          {research.partial.length === 0 ? null : (
            <p data-testid="research-partial" className="type-small mt-3 rounded-input bg-warn-bg px-3 py-2.5 text-warn">
              {campaignsCopy.planPartial} {unwrittenNames(research.partial)}.
            </p>
          )}
        </div>

        <ResearchNav placement="top" />

        {SECTIONS.map(({ part, Body }) => (
          <Body key={part} research={research} kit={WEB} />
        ))}
      </div>
    </div>
  );
}
