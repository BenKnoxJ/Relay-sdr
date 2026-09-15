"use client";

import Link from "next/link";
import { useState } from "react";

import type { AskAnswer } from "@/lib/campaigns/state";
import { usd } from "@/lib/campaigns/state";
import type { BriefFields, CampaignOverview, SpendView } from "@/lib/campaigns/types";
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
}: {
  overview: CampaignOverview | null;
  researchHref?: string;
  spend: SpendView | null;
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
        {current === "spend" ? <SpendLines spend={spend} /> : null}
        {current === "brief" ? <BriefCard brief={brief} editHref={editHref} bare /> : null}
        {current === "ask" ? <AskRelay questions={ask} bare /> : null}
      </div>
    </aside>
  );
}

/** What this campaign has spent so far, in the unit each spend is counted in. Nothing is drawn as a zero of work that has not happened. */
export function SpendLines({ spend }: { spend: SpendView | null }) {
  const c = campaignsCopy;
  if (spend === null || (spend.researchUsd === null && spend.search === null && spend.reveal === null)) {
    return (
      <p data-testid="spend-none" className="type-small text-muted">
        {c.spendNothingYet}
      </p>
    );
  }
  const rows: [string, string, string][] = [
    ["spend-research", c.spendResearch, spend.researchUsd === null ? c.spendNoRecord : usd(spend.researchUsd)],
    ...(spend.search === null ? [] : [["spend-search", c.spendSearch, `${spend.search.charged} ${c.spendCreditsOf} ${spend.search.cap} ${c.spendCreditsWord}`] as [string, string, string]]),
    ...(spend.reveal === null ? [] : [["spend-reveal", c.spendReveal, `${spend.reveal.charged} ${c.spendCreditsOf} ${spend.reveal.max} ${c.spendCreditsWord}`] as [string, string, string]]),
  ];
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
      {spend.sample ? (
        <p data-testid="spend-sample" className="type-small mt-2 text-warn">
          {c.spendSample}
        </p>
      ) : null}
    </div>
  );
}
