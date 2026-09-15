import { shellCopy } from "@/lib/copy/shell";

/**
 * What a page under the shell shows while its server work runs.
 *
 * One quiet line and no spinner. Nothing on the signed screens spins, and a
 * page here waits on one database read; a wheel would promise more work than
 * is happening. `role="status"` so the wait is announced once and not
 * interrupted.
 */
export default function Loading() {
  return (
    <p role="status" className="type-small text-muted">
      {shellCopy.loading}
    </p>
  );
}
