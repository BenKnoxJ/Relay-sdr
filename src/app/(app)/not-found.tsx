import Link from "next/link";

import { Card } from "@/components/Card";
import { shellCopy } from "@/lib/copy/shell";

/**
 * Where a wrong address under the shell lands, and where `notFound()` sends a
 * rep whose campaign is not theirs or not there.
 *
 * One line and one way out. The nav is still above it, so every area is a
 * click away; Home is named because it is where the next thing starts.
 */
export default function NotFound() {
  return (
    <Card className="mx-auto max-w-measure">
      <h1 className="type-heading mb-4">{shellCopy.notFoundHeading}</h1>
      <Link
        href="/"
        className="inline-flex items-center justify-center rounded-pill border-control border-action bg-transparent px-4 py-2 text-13 font-semibold text-action transition-opacity duration-micro ease-standard hover:opacity-90 focus-visible:outline-none focus-visible:ring-2"
      >
        {shellCopy.notFoundHome}
      </Link>
    </Card>
  );
}
