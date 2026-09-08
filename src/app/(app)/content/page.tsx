import { Card } from "@/components/Card";
import { EmptyState } from "@/components/EmptyState";
import { PageHeader } from "@/components/PageHeader";
import { contentCopy } from "@/lib/copy/content";

/**
 * Content before its slice (master doc §23.0: "Shown to every rep from day one
 * as 'coming'").
 *
 * The area is in the nav from the first pilot, so it opens to a state that
 * says what it will do and when, in rep words. Nothing on it is clickable:
 * there is nowhere for a click to go.
 *
 * The drawing is the signed mock's own (section 6), stroked in `currentColor`
 * so it takes the tile's colour and follows the theme rather than pinning a
 * hex that would be wrong in dark.
 */
export default function ContentPage() {
  return (
    <>
      <PageHeader title={contentCopy.title} note={contentCopy.note} />
      <Card className="p-0">
        <EmptyState
          icon={
            <svg width="22" height="22" viewBox="0 0 22 22" aria-hidden focusable="false">
              <path
                d="M4 6h14M4 11h14M4 16h9"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              />
            </svg>
          }
          heading={contentCopy.heading}
          body={contentCopy.body}
        />
      </Card>
    </>
  );
}
