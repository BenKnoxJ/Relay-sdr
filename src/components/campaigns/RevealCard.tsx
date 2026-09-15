"use client";

import { Card } from "@/components/Card";
import { PillButton } from "@/components/PillButton";
import type { RevealPlanView } from "@/lib/campaigns/types";
import { campaignsCopy } from "@/lib/copy/campaigns";

/**
 * Reveal emails, before it is pressed (lead gen v2.1 §6; v2.2 §9a): who will
 * be bought, who is already known, and the most it can cost, then one
 * explicit confirmation. Nothing is bought until the confirm button is
 * pressed, and the server refuses it if these figures have changed.
 */

const credits = (n: number) => `${n} ${n === 1 ? campaignsCopy.revealCreditOne : campaignsCopy.revealCreditMany}`;

/** The confirm button's words: "Reveal 4 emails, up to 4 credits", or "Add 3 known emails, no credits". */
export function revealButtonLabel(plan: Pick<RevealPlanView, "toReveal" | "known" | "maxCredits">): string {
  const c = campaignsCopy;
  if (plan.toReveal === 0) {
    return `${c.revealButtonAdd} ${plan.known} ${plan.known === 1 ? c.revealButtonKnownOne : c.revealButtonKnownMany} ${c.revealNoCredits}`;
  }
  return `${c.revealButtonReveal} ${plan.toReveal} ${plan.toReveal === 1 ? c.revealButtonEmailOne : c.revealButtonEmailMany} ${c.revealUpTo} ${credits(plan.maxCredits)}`;
}

export function RevealCard({
  plan,
  pending,
  error,
  onConfirm,
  onCancel,
}: {
  plan: RevealPlanView;
  pending: boolean;
  error: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const c = campaignsCopy;
  const rows: [string, string, string][] = [
    ["reveal-kept", c.revealRowKept, `${plan.kept}`],
    ["reveal-known", c.revealRowKnown, `${plan.known} · ${c.revealNoCredits}`],
    ["reveal-to-reveal", c.revealRowToReveal, plan.toReveal === 0 ? "0" : `${plan.toReveal} · ${c.revealUpTo} ${credits(plan.maxCredits)}`],
    ...(plan.noEmail > 0 ? [["reveal-no-email", c.revealRowNoEmail, `${plan.noEmail}`] as [string, string, string]] : []),
    ...(plan.unavailable > 0 ? [["reveal-unavailable", c.revealRowUnavailable, `${plan.unavailable}`] as [string, string, string]] : []),
  ];
  return (
    <Card label={c.revealCardLabel}>
      <div data-testid="reveal-card">
        <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1.5">
          {rows.map(([id, label, value]) => (
            <div key={id} className="contents">
              <dt className="type-small text-muted">{label}</dt>
              <dd data-testid={id} className="type-mono text-right text-13">
                {value}
              </dd>
            </div>
          ))}
        </dl>
        {plan.free > 0 ? (
          <p data-testid="reveal-free" className="type-small mt-2 text-muted">
            {plan.free} {c.revealFreeTail}
          </p>
        ) : null}
        <p className="type-small mt-2 text-muted">{c.revealEmailsOnly}</p>
        {error === null ? null : (
          <p role="alert" data-testid="reveal-error" className="type-small mt-2 text-warn">
            {error}
          </p>
        )}
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <PillButton data-testid="reveal-confirm" disabled={pending} onClick={onConfirm}>
            {pending ? c.actionRevealing : revealButtonLabel(plan)}
          </PillButton>
          <PillButton data-testid="reveal-cancel" variant="outline" disabled={pending} onClick={onCancel}>
            {c.revealCancel}
          </PillButton>
        </div>
      </div>
    </Card>
  );
}
