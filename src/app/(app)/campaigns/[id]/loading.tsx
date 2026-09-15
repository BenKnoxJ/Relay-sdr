import { shellCopy } from "@/lib/copy/shell";

/**
 * A campaign while its record is read (final MVP pass): the header's place
 * kept, one quiet line in it, no spinner. Moving between campaigns then
 * changes the words on the page rather than blanking it.
 */
export default function Loading() {
  return (
    <div className="-mx-6 mb-grid border-b border-line bg-panel px-6 pb-3 pt-1">
      <p role="status" className="type-small min-h-[88px] text-muted">
        {shellCopy.loading}
      </p>
    </div>
  );
}
