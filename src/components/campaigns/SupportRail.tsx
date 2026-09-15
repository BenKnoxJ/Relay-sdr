"use client";

import Link from "next/link";
import { useState } from "react";

import type { AskAnswer } from "@/lib/campaigns/state";
import { usd } from "@/lib/campaigns/stageLine";
import type { BriefFields, CampaignOverview, CampaignSpendView } from "@/lib/campaigns/types";
import { campaignsCopy } from "@/lib/copy/campaigns";
import { researchCopy } from "@/lib/copy/research";
import { cn } from "@/lib/utils";

import { AskRelay } from "./AskRelay";
import { BriefCard } from "./BriefCard";
import { Overview } from "./Overview";

/**
 * The campaign page's support rail (product-truth pass): what the rep may
 * want beside the work, in one quiet panel with four tabs, rather than four
 * cards of equal weight stacked down the right.
 *
 * Research is the Overview folded to a line with the way into everything
 * research found; Spend is what this campaign has cost so far in each unit
 * it is counted in; Brief is the brief as read; Ask is the six questions.
 * Nothing here is the rep's job on this page, which is why it is quiet.
 */

type Tab = "research" | "spend" | "brief" | "ask";

export function SupportRail({
  overview,
  researchHref,
  spend,
  brief,
  editHref,
  ask,
  initial = "research",
  confirmed = false,
  sample = false,
}: {
  overview: CampaignOverview | null;
  researchHref?: string;
  spend: CampaignSpendView | null;
  /** People and credits are samples, never a live account. */
  sample?: boolean;
  brief: BriefFields;
  editHref?: string;
  ask: AskAnswer[];
  initial?: Tab;
  confirmed?: boolean;
}) {
  const c = campaignsCopy;
  const tabs: { id: Tab; label: string }[] = [
    ...(overview === null ? [] : [{ id: "research" as const, label: c.railResearch }]),
    { id: "spend", label: c.railSpend },
    { id: "brief", label: c.railBrief },
    { id: "ask", label: c.railAsk },
  ];
  const [tab, setTab] = useState<Tab>(overview === null && initial === "research" ? "spend" : initial);
  const current = tabs.some((entry) => entry.id === tab) ? tab : (tabs[0]?.id ?? "spend");

  return (
    <aside data-testid="support-rail" className="rounded-card border border-line bg-panel">
      <div role="tablist" aria-label={c.railLabel} className="flex flex-wrap gap-1 border-b border-line px-3 pt-2">
        {tabs.map((entry) => (
          <button
            key={entry.id}
            type="button"
            role="tab"
            data-testid={`rail-tab-${entry.id}`}
            aria-selected={current === entry.id}
            onClick={() => setTab(entry.id)}
            className={cn(
              "-mb-px border-b-2 px-2 pb-2 pt-1 text-13 font-semibold transition-colors duration-micro ease-standard focus-visible:outline-none focus-visible:ring-2",
              current === entry.id ? "border-action text-ink" : "border-transparent text-muted hover:text-ink",
            )}
          >
            {entry.label}
          </button>
        ))}
      </div>
      <div role="tabpanel" data-testid={`rail-panel-${current}`} className="p-card">
        {current === "research" && overview !== null ? (
          <div className="grid gap-3">
            {researchHref === undefined ? null : (
              <Link href={researchHref} data-testid="rail-research-link" className="type-small inline-flex min-h-6 items-center font-semibold text-action focus-visible:outline-none focus-visible:ring-2">
                {researchCopy.openLink}
              </Link>
            )}
            <Overview overview={overview} confirmed={confirmed} collapsed bare />
          </div>
        ) : null}
        {current === "spend" ? <SpendLines spend={spend} sample={sample} /> : null}
        {current === "brief" ? <BriefCard brief={brief} editHref={editHref} bare /> : null}
        {current === "ask" ? <AskRelay questions={ask} bare /> : null}
      </div>
    </aside>
  );
}

/**
 * What this campaign has spent so far, from the backend's spend facts: each
 * kind in its own unit, never added together. Nothing is drawn as a zero of
 * work that has not happened: before Confirm there is no search line, before
 * Reveal no reveal line, and research with no recorded cost says so.
 */
export function SpendLines({ spend, sample = false }: { spend: CampaignSpendView | null; sample?: boolean }) {
  const c = campaignsCopy;
  const search = spend === null || spend.search.cap === null ? null : spend.search;
  const reveal = spend === null || spend.reveal.max === null ? null : spend.reveal;
  const researchUsd = spend?.research.usd ?? null;
  if (search === null && reveal === null && researchUsd === null) {
    return (
      <p data-testid="spend-none" className="type-small text-muted">
        {c.spendNothingYet}
      </p>
    );
  }
  const held = (n: number) => (n > 0 ? ` · ${n} ${c.spendHeldShort}` : "");
  const rows: [string, string, string][] = [
    ["spend-research", c.spendResearch, researchUsd === null ? c.spendNoRecord : usd(researchUsd)],
    ...(search === null ? [] : [["spend-search", c.spendSearch, `${search.charged} ${c.spendCreditsOf} ${search.cap} ${c.spendCreditsWord}${held(search.held)}`] as [string, string, string]]),
    ...(reveal === null ? [] : [["spend-reveal", c.spendReveal, `${reveal.charged} ${c.spendCreditsOf} ${reveal.max} ${c.spendCreditsWord}${held(reveal.held)}`] as [string, string, string]]),
  ];
  const earlier = spend !== null && spend.allVersions.searchCharged + spend.allVersions.revealCharged > (search?.charged ?? 0) + (reveal?.charged ?? 0);
  return (
    <div data-testid="spend-lines">
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5">
        {rows.map(([id, label, value]) => (
          <div key={id} className="contents">
            <dt className="type-small text-muted">{label}</dt>
            <dd data-testid={id} className="type-mono text-13">
              {value}
            </dd>
          </div>
        ))}
      </dl>
      {earlier && spend !== null ? (
        <p data-testid="spend-earlier" className="type-small mt-2 text-muted">
          {c.spendEarlierVersions} {spend.allVersions.searchCharged} {c.spendSearch.toLowerCase()} · {spend.allVersions.revealCharged} {c.spendReveal.toLowerCase()} {c.spendCreditsWord}.
        </p>
      ) : null}
      {sample ? (
        <p data-testid="spend-sample" className="type-small mt-2 text-warn">
          {c.spendSample}
        </p>
      ) : null}
    </div>
  );
}
