import { Card } from "@/components/Card";
import { campaignsCopy } from "@/lib/copy/campaigns";
import type { ResearchPack } from "../../../agents/research/output.schema";

import { PackItem } from "./PackItem";

/**
 * The insufficient-evidence stop (§23.1c, mock 3c): what research did find,
 * and the three ways to widen. Nothing is spent.
 *
 * The three widenings come from the pack's own `insufficient` block, which the
 * contract types as a tuple of exactly three (`insufficientSchema`). They are
 * not written here and they are not a fixed list: research names them, and a
 * screen that hard-coded "region, size, pain" would be guessing on behalf of a
 * run that already decided.
 */

const HEADINGS: Record<"region" | "size" | "pain", string> = {
  region: campaignsCopy.widenRegion,
  size: campaignsCopy.widenSize,
  pain: campaignsCopy.widenPain,
};

export function WidenCard({ insufficient }: { insufficient: NonNullable<ResearchPack["insufficient"]> }) {
  return (
    <Card className="max-w-[760px]">
      <p className="type-small mb-4 rounded-input bg-warn-bg px-3 py-2.5 text-warn">
        {campaignsCopy.stopBanner}
      </p>

      <div className="grid gap-grid wide:grid-cols-2">
        <div>
          <h3 className="type-label mb-1.5">{campaignsCopy.stopFound}</h3>
          {insufficient.found.map((item) => (
            <PackItem key={item.id} item={item} />
          ))}
        </div>

        <div>
          <h3 className="type-label mb-1.5">{campaignsCopy.stopHelp}</h3>
          <ul>
            {/*
              Keyed by position, not by kind: the contract is a tuple of three
              widenings and nothing in it says the three kinds are distinct.
            */}
            {insufficient.widenings.map((widening, index) => (
              <li key={index} data-testid="widening" className="py-1.5">
                <span className="type-small block font-semibold">{HEADINGS[widening.kind]}</span>
                <span className="type-small block text-muted">{widening.text}</span>
              </li>
            ))}
          </ul>
          <p className="type-small mt-2 text-muted">{campaignsCopy.stopChooseOne}</p>
        </div>
      </div>
    </Card>
  );
}
