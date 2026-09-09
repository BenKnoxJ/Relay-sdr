import { Card } from "@/components/Card";
import { EmptyState } from "@/components/EmptyState";
import { PageHeader } from "@/components/PageHeader";
import { emptyCopy } from "@/lib/copy/empty";

/**
 * Campaigns before there is one (master doc §23.1c).
 *
 * It points back at Home, which is where the brief box is on day one (§23.1a)
 * and the only door there is. Deliberately a sentence and not a button: "New
 * campaign" is absent from the shell until a campaign exists, and a button
 * here would be the same door wearing a different coat.
 */
export default function CampaignsPage() {
  return (
    <>
      <PageHeader title={emptyCopy.campaigns.title} note={emptyCopy.campaigns.note} />
      <Card className="p-0">
        <EmptyState heading={emptyCopy.campaigns.heading} body={emptyCopy.campaigns.body} />
      </Card>
    </>
  );
}
