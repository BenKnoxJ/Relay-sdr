"use client";

import { Card } from "@/components/Card";
import { PillButton } from "@/components/PillButton";
import { campaignsCopy } from "@/lib/copy/campaigns";

/**
 * Write emails, before it is pressed (outreach v2.1): how many first emails
 * Relay will draft, how it chooses what each opens on, the drafting ceiling,
 * and that nothing is sent. One confirmation.
 */
export function WriteCard({ people, costCeilingUsd, pending, error, onConfirm, onCancel }: { people: number; costCeilingUsd: number; pending: boolean; error: string | null; onConfirm: () => void; onCancel: () => void }) {
  const c = campaignsCopy;
  return (
    <Card label={c.writeCardLabel}>
      <div data-testid="write-card">
        <p data-testid="write-lead" className="type-body">
          {c.writeLead} {people} {people === 1 ? c.writePerson : c.writePeople}
        </p>
        <p className="type-small mt-1.5 text-muted">{c.writeHow}</p>
        <p data-testid="write-cost" className="type-small mt-1.5 text-muted">
          {c.writeCost} ${costCeilingUsd} {c.writeCostTail}
        </p>
        {error === null ? null : (
          <p role="alert" data-testid="write-error" className="type-small mt-2 text-warn">
            {error}
          </p>
        )}
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <PillButton data-testid="write-confirm" disabled={pending} onClick={onConfirm}>
            {pending ? c.actionWriting : c.writeConfirm}
          </PillButton>
          <PillButton data-testid="write-cancel" variant="outline" disabled={pending} onClick={onCancel}>
            {c.writeCancel}
          </PillButton>
        </div>
      </div>
    </Card>
  );
}
