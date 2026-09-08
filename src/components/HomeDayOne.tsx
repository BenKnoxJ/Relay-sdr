import { BriefBox } from "./BriefBox";
import { Card } from "./Card";
import { PageHeader } from "./PageHeader";

import { homeCopy } from "@/lib/copy/home";
import { cn } from "@/lib/utils";

/**
 * Home before there is a campaign (master doc §23.1a, "Day one (no
 * campaign)"), as drawn in section 1b of the signed mock.
 *
 * A single card carrying the Start screen's one-line brief box, with a connect
 * prompt above it for each connection that is not yet made. Nothing else is on
 * the page and nothing else is clickable, which is the signed state and not a
 * placeholder for one.
 *
 * Pure: every value arrives as a prop, so the route can be a server component
 * that resolves the session and this can be rendered in a test without one.
 *
 * `rail` is the widget slot the exit condition asks for. Slice 1's widgets go
 * in it and the layout does not move: the grid becomes the signed two-column
 * `home` layout the moment there is something to put in the right-hand column.
 * It stays one column while the rail is empty, because the signed day-one mock
 * centres the card rather than parking it left of a two-column gap.
 */
export function HomeDayOne({
  firstName,
  today,
  connections,
  startBrief,
  rail,
}: {
  firstName: string;
  /** Already formatted by the server, so the markup does not depend on the reader's clock. */
  today: string;
  connections: { mailbox: boolean; zoho: boolean };
  startBrief: (previous: string | null, form: FormData) => Promise<string | null>;
  rail?: React.ReactNode;
}) {
  const prompts = [
    connections.mailbox ? null : homeCopy.connectMailbox,
    connections.zoho ? null : homeCopy.connectZoho,
  ].filter((line) => line !== null);

  return (
    <>
      <PageHeader title={`${homeCopy.welcome}, ${firstName}`} note={today} />

      <div
        data-testid="home-grid"
        className={cn("grid gap-grid", rail === undefined ? null : "wide:grid-cols-home")}
      >
        <div>
          {/* 640px and the 32px padding are the signed mock's own numbers (1b). */}
          <Card className="mx-auto mt-8 max-w-[640px] p-8 pb-7 text-center">
            <h2 className="type-heading mb-1.5">{homeCopy.briefQuestion}</h2>
            <p className="type-body mb-4 text-muted">{homeCopy.briefHint}</p>

            {prompts.length === 0 ? null : (
              <div className="mb-4">
                {prompts.map((line) => (
                  <p key={line} className="type-small text-muted">
                    {line}
                  </p>
                ))}
              </div>
            )}

            <BriefBox
              label={homeCopy.briefQuestion}
              placeholder={homeCopy.briefPlaceholder}
              submitLabel={homeCopy.briefStart}
              action={startBrief}
            />

            <p className="type-small mt-4 text-12 text-muted">{homeCopy.briefFooter}</p>
          </Card>
        </div>

        {rail === undefined ? null : (
          <div data-testid="home-rail" className="grid gap-grid">
            {rail}
          </div>
        )}
      </div>
    </>
  );
}
