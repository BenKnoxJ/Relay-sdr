import { Card } from "@/components/Card";
import { campaignsCopy } from "@/lib/copy/campaigns";
import type { Item, PlanCards, Widening } from "../../../agents/research/output.schema";

import { PackItem } from "./PackItem";

/**
 * The insufficient-evidence stop (§23.1c, mock 3c): what research did find,
 * and the ways to widen. Nothing is spent.
 *
 * The widenings come from the pack's own `insufficient` block — one to three
 * genuine options on region, size, sector or role (research v3.2, §10 note
 * 28). They are not written here and they are not a fixed list: research
 * names them, and a screen that hard-coded them would be guessing on behalf of
 * a run that already decided. `found` is the evidence the stop cites, resolved
 * from the pack's m00 and m01 items by the caller: the stop names it by id.
 *
 * `canChoose` is false on a real campaign until choosing an option is built:
 * the options are shown as research wrote them, and the card says choosing
 * one arrives next rather than inviting a choice nothing acts on.
 */

const HEADINGS: Record<Widening["dimension"], string> = {
  region: campaignsCopy.widenRegion,
  size: campaignsCopy.widenSize,
  sector: campaignsCopy.widenSector,
  role: campaignsCopy.widenRole,
};

export function WidenCard({
  insufficient,
  found,
  canChoose = true,
}: {
  insufficient: NonNullable<PlanCards["insufficient"]>;
  found: Item[];
  canChoose?: boolean;
}) {
  return (
    <Card className="max-w-[760px]">
      <p className="type-small mb-3 rounded-input bg-warn-bg px-3 py-2.5 text-warn">
        {campaignsCopy.stopBanner}
      </p>
      {/* Why research stopped, in research's own words (the stop's `reason`, v3.2 note 28). */}
      <p data-testid="stop-reason" className="type-body mb-4">
        {insufficient.reason}
      </p>

      <div className="grid gap-grid wide:grid-cols-2">
        <div>
          <h3 className="type-label mb-1.5">{campaignsCopy.stopFound}</h3>
          {found.map((item) => (
            <PackItem key={item.id} item={item} />
          ))}
        </div>

        <div>
          <h3 className="type-label mb-1.5">{campaignsCopy.stopHelp}</h3>
          <ul>
            {/*
              Keyed by position, not by dimension: two options can widen the
              same dimension two ways (brief C's stop offers two regions).
            */}
            {insufficient.widenings.map((widening, index) => (
              <li key={index} data-testid="widening" className="py-1.5">
                <span className="type-small block font-semibold">{HEADINGS[widening.dimension]}</span>
                <span className="type-small block text-muted">{widening.text}</span>
              </li>
            ))}
          </ul>
          <p data-testid="widen-note" className="type-small mt-2 text-muted">
            {canChoose ? campaignsCopy.stopChooseOne : campaignsCopy.stopChooseLater}
          </p>
        </div>
      </div>
    </Card>
  );
}
