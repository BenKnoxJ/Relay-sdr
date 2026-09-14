"use client";

import Link from "next/link";
import { useState } from "react";

import { Card } from "@/components/Card";
import type { CampaignOverview } from "@/lib/campaigns/types";
import { campaignsCopy, startCopy } from "@/lib/copy/campaigns";
import { researchCopy } from "@/lib/copy/research";

import { PackItem, PackPhrase, WithHosts, sourceHost } from "./PackItem";

/**
 * The campaign Overview (§23.1c, amended by task 18): research's findings in
 * the six parts a rep decides on, each a lookup into the stored pack.
 *
 * In short, Start with, Buyer groups, Pains and buyer language, Example firms
 * and Check first. The longer lists (every gap, everything that argues against
 * the case) are one click away and never a wall of text: each is its own
 * finding. A url research wrote is shown as its host; the url is only ever
 * where the link goes, so no string of pack text can widen the page.
 */

const CHANNELS: Record<string, string> = {
  email: startCopy.channelEmail,
  linkedin: startCopy.channelLinkedin,
  calls: startCopy.channelCalls,
};

const KINDS: Record<CampaignOverview["gaps"][number]["kind"], string> = {
  "not-found": campaignsCopy.kindNotFound,
  "confirmed-absent": campaignsCopy.kindConfirmedAbsent,
  unreadable: campaignsCopy.kindUnreadable,
  conflicting: campaignsCopy.kindConflicting,
  "out-of-budget": campaignsCopy.kindOutOfBudget,
};

/**
 * What the pains part shows before "Show all pains and language": the rank-1
 * group's first two pains (research lists them most acute first) and one of
 * its buyers' own phrases. Everything else is one click away.
 */
const PAINS_FIRST = 2;
const WORDS_FIRST = 1;

/** A "show" / "hide" that opens more of the same part in place. */
function More({ label, testId, children }: { label: string; testId: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-2">
      <button
        type="button"
        aria-expanded={open}
        data-testid={testId}
        onClick={() => setOpen(!open)}
        className="type-small inline-flex min-h-6 items-center rounded-pill font-semibold text-action focus-visible:outline-none focus-visible:ring-2"
      >
        {open ? campaignsCopy.overviewHide : campaignsCopy.overviewShow} {label}
      </button>
      {open ? <div className="mt-1.5">{children}</div> : null}
    </div>
  );
}

function Part({ label, testId, children }: { label: string; testId: string; children: React.ReactNode }) {
  return (
    <section data-testid={testId} className="min-w-0 border-t border-line pt-3 first:border-t-0 first:pt-0">
      <h3 className="type-label mb-1.5">{label}</h3>
      {children}
    </section>
  );
}

function sizeLine(size: CampaignOverview["firms"][number]["firms"][number]["size"]): string {
  if (size.status === "unknown" || size.value === undefined) return campaignsCopy.sizeUnknown;
  return `${size.value} (${size.status === "confirmed" ? campaignsCopy.sizeConfirmed : campaignsCopy.sizeEstimated})`;
}

export function Overview({
  overview,
  editHref,
  researchHref,
  confirmed = false,
}: {
  overview: CampaignOverview;
  editHref?: string;
  researchHref?: string;
  /** The plan is confirmed and the search has run or is running: no "nobody found yet". */
  confirmed?: boolean;
}) {
  const c = campaignsCopy;
  const firmCount = overview.firms.reduce((sum, group) => sum + group.firms.length, 0);

  return (
    <Card
      label={c.planLabel}
      // The one way into everything research found (task 19).
      aside={
        researchHref === undefined ? undefined : (
          <Link
            href={researchHref}
            data-testid="overview-research-link"
            className="type-small inline-flex min-h-6 shrink-0 items-center rounded-pill font-semibold text-action focus-visible:outline-none focus-visible:ring-2"
          >
            {researchCopy.openLink}
          </Link>
        )
      }
    >
      <div data-testid="overview" className="grid min-w-0 gap-4 [overflow-wrap:anywhere]">
        {overview.partial.length === 0 ? null : (
          <p data-testid="plan-partial" className="type-small rounded-input bg-warn-bg px-3 py-2.5 text-warn">
            {c.planPartial} {overview.partial.map((id) => (c.partNames as Record<string, string>)[id] ?? id).join(", ")}.
          </p>
        )}

        {overview.inShort.lines.length === 0 && overview.inShort.verdict === null ? null : (
          <Part label={c.inShortLabel} testId="overview-in-short">
            <ul className="grid gap-1.5">
              {overview.inShort.lines.map((line, index) => (
                <li key={index} data-testid="in-short-line" className="type-small">
                  {c.inShortLines[index] === undefined ? null : (
                    <span data-testid="in-short-label" className="type-label mb-0.5 block text-muted">
                      {c.inShortLines[index]}
                    </span>
                  )}
                  <span data-testid="in-short-text">{line}</span>
                </li>
              ))}
            </ul>
            {overview.inShort.verdict === null ? null : (
              <p data-testid="in-short-view" className="type-small mt-2">
                <span className="font-semibold">{c.inShortView}</span> {overview.inShort.verdict}
              </p>
            )}
            <p data-testid="overview-sources" className="type-small mt-1.5 text-muted">
              {c.basedOn} {overview.sources} {overview.sources === 1 ? c.countSource : c.fromSources}
            </p>
          </Part>
        )}

        {overview.startWith === null ? null : (
          <Part label={c.startWithLabel} testId="overview-start-with">
            <p className="type-name">{overview.startWith.groupName}</p>
            <dl className="mt-1.5 grid grid-cols-1 gap-x-3 gap-y-1 wide:grid-cols-[auto_minmax(0,1fr)]">
              {(
                [
                  [c.startAngle, overview.startWith.angle],
                  [c.startWhyNow, overview.startWith.whyNow],
                  [c.startWrongIf, overview.startWith.wrongIf],
                  [c.startChannels, overview.startWith.channels.map((channel) => CHANNELS[channel] ?? channel).join(", ")],
                ] as [string, string][]
              ).map(([label, value]) => (
                <div key={label} className="contents">
                  <dt className="type-small font-semibold">{label}</dt>
                  <dd className="type-small min-w-0">{value}</dd>
                </div>
              ))}
            </dl>
          </Part>
        )}

        {overview.groups.length === 0 ? null : (
          <Part label={c.groupsLabel} testId="overview-groups">
            <p className="type-small mb-2 text-muted">{confirmed ? c.groupsNoteConfirmed : c.groupsNote}</p>
            <ul className="grid gap-chips wide:grid-cols-2">
              {overview.groups.map((group) => (
                <li key={group.id} data-testid="overview-group" className="min-w-0 rounded-input border border-line bg-ground p-3">
                  <p className="type-small font-semibold">
                    {group.name}
                    {group.first ? <span className="ml-1.5 text-action">{c.startHere}</span> : null}
                  </p>
                  <p className="type-small text-muted">
                    {c.groupSize} {group.sizeRange}
                  </p>
                  {(["runs", "champions", "signs"] as const).map((part) => {
                    const titles = group.roles.filter((role) => role.part === part).map((role) => role.title);
                    return titles.length === 0 ? null : (
                      <p key={part} className="type-small">
                        <span className="text-muted">{c.roleParts[part]}:</span> {titles.join(", ")}
                      </p>
                    );
                  })}
                  <More label={c.groupSituation} testId="group-more">
                    <p className="type-small text-muted">{group.situation}</p>
                  </More>
                </li>
              ))}
            </ul>
          </Part>
        )}

        {overview.pain === null ? null : (
          <Part label={c.painLabel} testId="overview-pain">
            <p className="type-small mb-1 text-muted">
              {c.forGroup} {overview.pain.groupName}
            </p>
            {overview.pain.pains.slice(0, PAINS_FIRST).map((pain) => (
              <PackItem key={pain.id} item={pain} quoteFirst />
            ))}
            <p className="type-small mt-2 font-semibold">{c.buyerWordsLabel}</p>
            <div data-testid="buyer-words">
              {overview.pain.buyerWords.length === 0 ? (
                <p className="type-small text-muted">{c.noBuyerWords}</p>
              ) : (
                overview.pain.buyerWords.slice(0, WORDS_FIRST).map((phrase) => <PackPhrase key={phrase.id} phrase={phrase} />)
              )}
            </div>
            {overview.pain.pains.length <= PAINS_FIRST &&
            overview.pain.buyerWords.length <= WORDS_FIRST &&
            overview.pain.otherVoices.length === 0 ? null : (
              <More label={c.allPainsAndLanguage} testId="pain-more">
                <div data-testid="more-pains">
                  {overview.pain.pains.slice(PAINS_FIRST).map((pain) => (
                    <PackItem key={pain.id} item={pain} quoteFirst />
                  ))}
                </div>
                {overview.pain.buyerWords.length <= WORDS_FIRST ? null : (
                  <>
                    <p className="type-small mt-2 font-semibold">{c.buyerWordsLabel}</p>
                    <div data-testid="more-buyer-words">
                      {overview.pain.buyerWords.slice(WORDS_FIRST).map((phrase) => (
                        <PackPhrase key={phrase.id} phrase={phrase} />
                      ))}
                    </div>
                  </>
                )}
                {overview.pain.otherVoices.length === 0 ? null : (
                  <>
                    <p className="type-small mt-2 font-semibold">{c.otherVoicesLabel}</p>
                    <div data-testid="other-voices">
                      {overview.pain.otherVoices.map((phrase) => (
                        <PackPhrase key={phrase.id} phrase={phrase} />
                      ))}
                    </div>
                  </>
                )}
              </More>
            )}
          </Part>
        )}

        {firmCount === 0 ? null : (
          <Part label={c.firmsLabel} testId="overview-firms">
            <p className="type-small mb-2 text-muted">{confirmed ? c.firmsNoteConfirmed : c.firmsNote}</p>
            {overview.firms.map((group) => (
              <div key={group.groupName} className="mb-2 min-w-0">
                <p className="type-small text-muted">{group.groupName}</p>
                <ul>
                  {group.firms.map((firm) => (
                    <li key={firm.id} data-testid="overview-firm" className="type-small">
                      <span className="font-semibold">{firm.name}</span>
                      {firm.domain === undefined ? null : <span className="text-muted"> {sourceHost(firm.domain)}</span>}
                      <span className={firm.size.status === "unknown" ? "text-warn" : "text-muted"}> · {sizeLine(firm.size)}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
            <More label={c.firmsWhy} testId="firms-more">
              {overview.firms.flatMap((group) =>
                group.firms.map((firm) => (
                  <div key={firm.id} className="mb-1.5">
                    <p className="type-small font-semibold">{firm.name}</p>
                    <PackItem item={firm.signal} />
                  </div>
                )),
              )}
            </More>
          </Part>
        )}

        {overview.checkFirst.summary === null && overview.checkFirst.questions.length === 0 && overview.gaps.length === 0 ? null : (
          <Part label={c.checkFirstLabel} testId="overview-check-first">
            {overview.checkFirst.summary === null ? null : <p className="type-small mb-1.5">{overview.checkFirst.summary}</p>}
            {overview.checkFirst.questions.length === 0 ? null : (
              <>
                <p className="type-small font-semibold">{c.checkFirstAsk}</p>
                <ol className="list-decimal pl-5">
                  {overview.checkFirst.questions.map((question) => (
                    <li key={question.id} data-testid="check-first-question" className="type-small">
                      {question.question}
                    </li>
                  ))}
                </ol>
              </>
            )}
            {overview.checkFirst.more.length === 0 ? null : (
              <More label={c.allQuestions} testId="questions-more">
                <ol start={overview.checkFirst.questions.length + 1} className="list-decimal pl-5">
                  {overview.checkFirst.more.map((question) => (
                    <li key={question.id} data-testid="check-first-more-question" className="type-small">
                      {question.question}
                    </li>
                  ))}
                </ol>
              </More>
            )}
            {overview.gaps.length === 0 && overview.contradictions.length === 0 ? null : (
              <More label={c.allGapsLabel} testId="gaps-more">
                {overview.gaps.map((gap) => (
                  <div key={gap.id} data-testid="overview-gap" className="mb-2.5">
                    <p className="type-small">
                      <WithHosts text={gap.text} />
                    </p>
                    <p className="type-small text-muted">{KINDS[gap.kind]}</p>
                    <p className="type-small">
                      <span className="text-muted">{c.whyItMatters}</span> {gap.whyItMatters}
                    </p>
                    {gap.askOnFirstCall === undefined ? null : (
                      <p className="type-small">
                        <span className="text-muted">{c.askOnCall}</span> {gap.askOnFirstCall}
                      </p>
                    )}
                  </div>
                ))}
                {overview.contradictions.length === 0 ? null : (
                  <div className="mt-2 border-t border-line pt-2">
                    <p className="type-small font-semibold">{c.againstLabel}</p>
                    {overview.contradictions.map((contradiction) => (
                      <div key={contradiction.id} data-testid="overview-contradiction" className="mb-2">
                        <p className="type-small">
                          <WithHosts text={contradiction.text} />
                        </p>
                        <p className="type-small">
                          <span className="text-muted">{c.meaningLabel}</span> {contradiction.meaning}
                        </p>
                        {contradiction.a === undefined ? null : <PackItem item={contradiction.a} />}
                        {contradiction.b === undefined ? null : <PackItem item={contradiction.b} />}
                      </div>
                    ))}
                  </div>
                )}
              </More>
            )}
          </Part>
        )}

        {editHref === undefined ? null : (
          <Link
            href={editHref}
            data-testid="overview-edit-brief"
            className="inline-flex min-h-6 items-center rounded-pill text-13 font-semibold text-action focus-visible:outline-none focus-visible:ring-2"
          >
            {c.editBrief}
          </Link>
        )}
      </div>
    </Card>
  );
}
