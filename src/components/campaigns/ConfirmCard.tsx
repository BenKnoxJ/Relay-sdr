import { Card } from "@/components/Card";
import type { ConfirmPlanView } from "@/lib/campaigns/types";
import { campaignsCopy } from "@/lib/copy/campaigns";

/**
 * What pressing Confirm plan does, before it is pressed (lead gen v2.1 §6,
 * §12): who the search is for, the credit limit it approves, and the
 * lawful-basis words the rep confirms. Sample people and credits say so.
 * Nothing about the provider itself: no ids, no taxonomy.
 */
export function ConfirmCard({ plan }: { plan: ConfirmPlanView }) {
  const c = campaignsCopy;
  return (
    <Card label={c.confirmLabel}>
      <dl data-testid="confirm-card" className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5">
        {plan.groupName === null ? null : (
          <>
            <dt className="type-small text-muted">{c.confirmFor}</dt>
            <dd data-testid="confirm-group" className="type-small">
              {plan.groupName}
            </dd>
          </>
        )}
        {plan.available && plan.searchCreditCap !== null ? (
          <>
            <dt className="type-small text-muted">{c.confirmSearch}</dt>
            <dd data-testid="confirm-cap" className="type-small">
              {plan.searchCreditCap} {c.confirmCredits}
            </dd>
          </>
        ) : null}
        <dt className="type-small text-muted">{c.confirmLawful}</dt>
        <dd data-testid="confirm-lawful" className="type-small">
          {plan.lawfulBasis}
        </dd>
      </dl>
      {plan.available && plan.sample ? (
        <p data-testid="confirm-sample" className="type-small mt-2.5 text-warn">
          {c.confirmSample}
        </p>
      ) : null}
    </Card>
  );
}
