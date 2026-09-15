"use client";

import { useState } from "react";

import { TextLink } from "@/components/TextButton";
import { usd } from "@/lib/campaigns/stageLine";
import type { ActivityEntry, BriefFields, CampaignOverview, CampaignSpendView } from "@/lib/campaigns/types";
import { campaignsCopy } from "@/lib/copy/campaigns";
import { researchCopy } from "@/lib/copy/research";
import { cn } from "@/lib/utils";

import { ActivityList } from "./ActivityList";
import { BriefCard } from "./BriefCard";
import { Overview } from "./Overview";

/**
 * The campaign page's support rail (product-truth pass): what the rep may
 * want beside the work, in one quiet panel with four tabs, rather than four
 * cards of equal weight stacked down the right.
 *
 * Research is the Overview folded to a line with the way into everything
 * research found; Spend is what this campaign has cost so far in each unit
 * it is counted in; Brief is the brief as read; Activity is what has
 * happened, newest first. Nothing here is the rep's job on this page, which
 * is why it is quiet. The tabs take the arrow keys, as tabs do.
 */

type Tab = "research" | "spend" | "brief" | "activity";

export function SupportRail({
  overview,
  researchHref,
  spend,
  brief,
  editHref,
  activity,
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
  /** Absent on a sample: there is no record behind it. */
  activity?: readonly ActivityEntry[];
  initial?: Tab;
  confirmed?: boolean;
}) {
  const c = campaignsCopy;
  const tabs: { id: Tab; label: string }[] = [
    ...(overview === null ? [] : [{ id: "research" as const, label: c.railResearch }]),
    { id: "spend", label: c.railSpend },
    { id: "brief", label: c.railBrief },
    ...(activity === undefined ? [] : [{ id: "activity" as const, label: c.railActivity }]),
  ];
  const [tab, setTab] = useState<Tab>(overview === null && initial === "research" ? "spend" : initial);
  const current = tabs.some((entry) => entry.id === tab) ? tab : (tabs[0]?.id ?? "spend");
  const move = (from: Tab, by: 1 | -1) => {
    const index = tabs.findIndex((entry) => entry.id === from);
    const next = tabs[(index + by + tabs.length) % tabs.length];
    if (next !== undefined) setTab(next.id);
  };

  return (
    <aside data-testid="support-rail" className="rounded-card border border-line bg-panel wide:sticky wide:top-[calc(var(--relay-header-h,0px)+16px)]">
      <div role="tablist" aria-label={c.railLabel} className="flex flex-wrap gap-1 border-b border-line px-3 pt-2">
        {tabs.map((entry) => (
          <button
            key={entry.id}
            type="button"
            role="tab"
            data-testid={`rail-tab-${entry.id}`}
            aria-selected={current === entry.id}
            tabIndex={current === entry.id ? 0 : -1}
            onClick={() => setTab(entry.id)}
            onKeyDown={(event) => {
              if (event.key === "ArrowRight") move(entry.id, 1);
              if (event.key === "ArrowLeft") move(entry.id, -1);
            }}
            className={cn(
              "-mb-px border-b-2 px-2 pb-2 pt-1 text-13 font-semibold transition-colors duration-micro ease-standard focus-visible:outline-none focus-visible:ring-2",
              current === entry.id ? "border-action text-ink" : "border-transparent text-muted hover:text-ink",
            )}
          >
            {entry.label}
          </button>
        ))}
      </div>
      <div role="tabpanel" data-testid={`rail-panel-${current}`} className="max-h-[calc(100vh-var(--relay-header-h,0px)-72px)] overflow-y-auto p-card">
        {current === "research" && overview !== null ? (
          <div className="grid gap-3">
            {researchHref === undefined ? null : (
              <TextLink href={researchHref} data-testid="rail-research-link">
                {researchCopy.openLink}
              </TextLink>
            )}
            <Overview overview={overview} confirmed={confirmed} collapsed bare />
          </div>
        ) : null}
        {current === "spend" ? <SpendLines spend={spend} sample={sample} /> : null}
        {current === "brief" ? <BriefCard brief={brief} editHref={editHref} bare /> : null}
        {current === "activity" && activity !== undefined ? <ActivityList entries={activity} /> : null}
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
