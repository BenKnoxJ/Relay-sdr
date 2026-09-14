import type { BriefFields, CampaignResearch, CampaignResearchPage, ResearchPart } from "@/lib/campaigns/types";
import { whereLine } from "@/lib/campaigns/briefLines";
import { campaignsCopy, startCopy } from "@/lib/copy/campaigns";
import { reportCopy } from "@/lib/copy/report";
import { researchCopy } from "@/lib/copy/research";
import { shellCopy } from "@/lib/copy/shell";

import { ConfidenceChip, shortDate } from "./PackItem";
import { SECTIONS, previewSegments, unwrittenNames, type Kit } from "./ResearchPage";

/**
 * The Campaign Research Pack (task 20): "What Relay learned" as a document,
 * for the rep to print or save as a PDF and share inside their company.
 *
 * It is on the research page from the start and shown only on paper
 * (`hidden print:block`), while the page itself is hidden there. So printing
 * needs nothing opened first and changes nothing on screen: whatever the rep
 * has open or closed, the pack is laid out whole, because it has nothing to
 * open. Its eleven parts are the page's own (`SECTIONS`), drawn from the same
 * research through the same code, with a layout for paper (`PRINT`) in place
 * of the page's disclosures. The cover and the opening page are made of what
 * the campaign page already shows: the brief, the Overview's In short and
 * Start with, and research's own date and source count. Nothing is summarised
 * or reworded, and nothing asks anything of the server.
 */

const PARTS = Object.keys(researchCopy.parts) as ResearchPart[];

/** "01" to "11": a part's place, as the cover's contents and its own heading give it. */
const place = (part: ResearchPart) => String(PARTS.indexOf(part) + 1).padStart(2, "0");

const MOTIONS: Record<BriefFields["motion"], string> = { direct: startCopy.motionDirect, channel: startCopy.motionChannel };
const CHANNELS: Record<string, string> = { email: startCopy.channelEmail, linkedin: startCopy.channelLinkedin, calls: startCopy.channelCalls };
const channelList = (channels: readonly string[]) => channels.map((channel) => CHANNELS[channel] ?? channel).join(", ");

/** A CSS string, from the copy file only: nothing a rep or research wrote is ever put into a stylesheet. */
const cssString = (text: string) => `"${text.replace(/["\\]/g, (char) => `\\${char}`)}"`;

/**
 * The page itself: A4, with the footer and page number in the margin of every
 * page but the cover. Browsers draw these margin boxes (`@bottom-left`) or
 * leave them out; they never cover the pack.
 */
const PAGE_STYLE = [
  "@page { size: A4; margin: 16mm 16mm 18mm;",
  `@bottom-left { content: ${cssString(reportCopy.footer)}; font-family: var(--font-sans), system-ui, sans-serif; font-size: 8pt; color: var(--relay-muted); }`,
  `@bottom-right { content: ${cssString(`${reportCopy.page} `)} counter(page) ${cssString(` ${reportCopy.pageOf} `)} counter(pages); font-family: var(--font-mono), ui-monospace, monospace; font-size: 8pt; color: var(--relay-muted); }`,
  "}",
  // Empty boxes along the top: a browser that would print its own header there (a date, the page's title) leaves the space to the pack.
  '@page { @top-left { content: ""; } @top-center { content: ""; } @top-right { content: ""; } }',
  // The cover has no footer of its own, and keeps the browser from printing one there.
  '@page :first { @bottom-left { content: ""; } @bottom-right { content: ""; } }',
].join(" ");

/** A part of the pack: its place and title, what it holds, what research did not write, and then all of it. */
function ReportPart({ part, research, empty, children }: { part: ResearchPart; research: CampaignResearch; empty: boolean; children: React.ReactNode }) {
  const missing = research.unwritten[part];
  const preview = previewSegments(part, research);
  return (
    <section id={`report-${part}`} data-testid={`report-${part}`} aria-labelledby={`report-${part}-title`} className="min-w-0 break-before-page">
      <header className="mb-5 break-after-avoid border-b-2 border-action pb-3">
        <p className="type-mono text-13 font-medium text-action">{place(part)}</p>
        <h2 id={`report-${part}-title`} className="type-display mt-1">
          {researchCopy.parts[part]}
        </h2>
        {preview.length === 0 ? null : (
          <p data-testid="report-preview" className="type-small mt-1.5 text-muted">
            {preview.map((segment, index) => (
              <span key={index} className={segment.warn === true ? "font-semibold text-warn" : undefined}>
                {index === 0 ? null : campaignsCopy.noteJoin}
                {segment.text}
              </span>
            ))}
          </p>
        )}
      </header>
      {missing.length === 0 ? null : (
        <p data-testid="part-unwritten" className="type-small mb-4 rounded-input border border-warn bg-warn-bg px-3 py-2.5 text-warn">
          {empty ? researchCopy.unwrittenAll : `${researchCopy.unwrittenSome} ${unwrittenNames(missing)}.`}
        </p>
      )}
      {empty ? missing.length === 0 ? <p className="type-small text-muted">{researchCopy.nothingHere}</p> : null : <div className="min-w-0">{children}</div>}
    </section>
  );
}

/** What the page keeps a click away, set out under its own label. */
function ReportMore({ label, testId, children }: { label: string; testId: string; children: React.ReactNode }) {
  return (
    <div data-testid={testId} className="mt-3 min-w-0">
      <p className="type-label mb-1.5 break-after-avoid">{label}</p>
      {children}
    </div>
  );
}

/** One kind of buyer, marked down its left edge so each group reads as its own. */
function ReportGroup({ name, testId, meta, children }: { name: string; open: boolean; testId: string; meta?: string; children: React.ReactNode }) {
  return (
    <div data-testid={testId} className="min-w-0 rounded-input border border-l-4 border-line border-l-action px-4 py-3">
      <div className="break-after-avoid">
        <h3 className="type-name">{name}</h3>
        {meta === undefined ? null : <p className="type-small text-muted">{meta}</p>}
      </div>
      <div className="mt-2 min-w-0">{children}</div>
    </div>
  );
}

/** Paper's way of laying out a part: everything, with nothing to open. Its ids are its own, so a link in the PDF lands in the PDF. */
const PRINT: Kit = { print: true, Part: ReportPart, More: ReportMore, Group: ReportGroup, id: (id) => `report-${id}` };

function Wordmark() {
  return (
    <span className="flex items-center gap-2 text-16 font-bold">
      {/* The Relay mark, as the nav draws it: the one sanctioned use of the gradient. */}
      <span aria-hidden className="block h-[22px] w-[22px] rounded-sm bg-wordmark" />
      {shellCopy.appName}
    </span>
  );
}

function Classification() {
  return (
    <p data-testid="report-classification" className="type-label rounded-pill border border-warn px-3 py-1 text-warn">
      {reportCopy.classification}
    </p>
  );
}

function Cover({ page, research }: { page: CampaignResearchPage; research: CampaignResearch }) {
  const f = reportCopy.fields;
  const researched = research.researchedOn === null ? null : shortDate(research.researchedOn);
  const fields: [string, string, string][] = [
    ["product", f.product, page.brief.product],
    ["motion", f.motion, MOTIONS[page.brief.motion]],
    ["where", f.where, whereLine(page.brief)],
    ["channels", f.channels, channelList(page.brief.channels)],
    ["researched", f.researched, researched ?? reportCopy.notDated],
    ["sources", f.sources, `${research.sources}`],
  ];
  return (
    <section data-testid="report-cover" aria-label={reportCopy.kind} className="flex min-h-[258mm] break-after-page flex-col">
      <div className="flex items-center justify-between gap-4">
        <Wordmark />
        <Classification />
      </div>

      <div className="mt-[26mm]">
        <p className="type-label text-action">{reportCopy.kind}</p>
        <h1 data-testid="report-name" className="mt-3 text-26 font-bold leading-tight">
          {page.name}
        </h1>
        <p className="type-label mt-6">{reportCopy.whoLabel}</p>
        <p data-testid="report-brief-who" className="type-body-large mt-1 max-w-measure">
          {page.brief.who}
        </p>
      </div>

      <div className="mt-8 rounded-card border border-line p-card">
        {[fields.slice(0, 4), fields.slice(4)].map((row, index) => (
          <dl key={index} className={index === 0 ? "grid grid-cols-4 gap-x-5" : "mt-4 grid grid-cols-4 gap-x-5 border-t border-line pt-4"}>
            {row.map(([key, label, value]) => (
              <div key={key} data-testid={`report-field-${key}`} className="min-w-0">
                <dt className="type-label">{label}</dt>
                <dd className={key === "researched" || key === "sources" ? "type-mono mt-1 text-13" : "type-small mt-1 font-medium"}>{value}</dd>
              </div>
            ))}
          </dl>
        ))}
      </div>

      <div className="mt-8">
        <p className="type-label mb-2">{reportCopy.contents}</p>
        <ol data-testid="report-contents" className="grid grid-flow-col grid-cols-2 grid-rows-6 gap-x-8 gap-y-1">
          {PARTS.map((part) => (
            <li key={part} className="type-small flex gap-3">
              <span className="type-mono w-5 shrink-0 text-13 text-action">{place(part)}</span>
              <a href={`#report-${part}`}>{researchCopy.parts[part]}</a>
            </li>
          ))}
        </ol>
      </div>

      <div data-testid="report-how-to-read" className="mt-8 max-w-measure">
        <h2 className="type-label mb-1.5">{reportCopy.howToRead}</h2>
        <p className="type-small max-w-measure">{reportCopy.howToReadText}</p>
        <p className="mt-2 flex flex-wrap gap-1.5">
          {(["strong", "moderate", "weak", "speculative"] as const).map((confidence) => (
            <ConfidenceChip key={confidence} confidence={confidence} />
          ))}
        </p>
      </div>
      <footer className="mt-auto border-t border-line pt-4">
        <p className="type-small font-semibold text-warn">{reportCopy.classification}</p>
        <p className="type-small mt-1 max-w-measure text-muted">{reportCopy.classificationNote}</p>
        <p className="type-small mt-2 text-muted">{reportCopy.preparedBy}</p>
      </footer>
    </section>
  );
}

/** The pack's opening page: the Overview's In short and Start with, as the campaign page shows them. */
function Glance({ page, research }: { page: CampaignResearchPage; research: CampaignResearch }) {
  const c = campaignsCopy;
  const inShort = page.summary?.inShort ?? null;
  const start = page.summary?.startWith ?? null;
  return (
    <section data-testid="report-glance" aria-labelledby="report-glance-title" className="min-w-0">
      <header className="mb-5 border-b-2 border-action pb-3">
        <h2 id="report-glance-title" className="type-display">
          {reportCopy.glance}
        </h2>
      </header>

      {research.partial.length === 0 ? null : (
        <p data-testid="report-partial" className="type-small mb-5 rounded-input border border-warn bg-warn-bg px-3 py-2.5 text-warn">
          {c.planPartial} {unwrittenNames(research.partial)}.
        </p>
      )}

      {inShort === null || (inShort.lines.length === 0 && inShort.verdict === null) ? null : (
        <div data-testid="report-in-short" className="break-inside-avoid">
          <h3 className="type-label mb-2">{c.inShortLabel}</h3>
          <dl className="grid grid-cols-[9rem_minmax(0,1fr)] gap-x-4 gap-y-2">
            {inShort.lines.map((line, index) => (
              <div key={index} className="contents">
                <dt className="type-small font-semibold">{c.inShortLines[index] ?? ""}</dt>
                <dd className="type-small min-w-0">{line}</dd>
              </div>
            ))}
          </dl>
          {inShort.verdict === null ? null : (
            <p className="type-small mt-4 rounded-input border border-line bg-ground px-4 py-3">
              <span className="font-semibold">{c.inShortView}</span> {inShort.verdict}
            </p>
          )}
        </div>
      )}

      {start === null ? null : (
        <div data-testid="report-start-with" className="mt-6 break-inside-avoid rounded-card border border-action bg-soft p-card">
          <h3 className="type-label text-action">{c.startWithLabel}</h3>
          <p className="type-name mt-1">{start.groupName}</p>
          <dl className="mt-2 grid grid-cols-[9rem_minmax(0,1fr)] gap-x-4 gap-y-1.5">
            {(
              [
                [c.startAngle, start.angle],
                [c.startWhyNow, start.whyNow],
                [c.startWrongIf, start.wrongIf],
                [c.startChannels, channelList(start.channels)],
              ] as [string, string][]
            ).map(([label, value]) => (
              <div key={label} className="contents">
                <dt className="type-small font-semibold">{label}</dt>
                <dd className="type-small min-w-0">{value}</dd>
              </div>
            ))}
          </dl>
        </div>
      )}

    </section>
  );
}

export function ResearchReport({ page, research }: { page: CampaignResearchPage; research: CampaignResearch }) {
  return (
    <article data-testid="research-report" aria-label={`${reportCopy.kind}${reportCopy.titleJoin}${page.name}`} className="relay-pack hidden min-w-0 text-ink [overflow-wrap:anywhere] print:block">
      <style>{PAGE_STYLE}</style>
      <Cover page={page} research={research} />
      <Glance page={page} research={research} />
      {SECTIONS.map(({ part, Body }) => (
        <Body key={part} research={research} kit={PRINT} />
      ))}
    </article>
  );
}
