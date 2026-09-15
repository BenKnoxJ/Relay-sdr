"use client";

import type { Role } from "@prisma/client";
import Link from "next/link";
import { usePathname } from "next/navigation";

import { navCopy } from "@/lib/copy/nav";
import { cn } from "@/lib/utils";

/**
 * The floating nav pill: the whole app map in one row (master doc §23.0).
 *
 * A client component for one reason — it marks the area the rep is in, and the
 * only honest source for that is the live path. Everything else it needs is a
 * prop, so the layout resolves the session once on the server and this renders
 * what it is told.
 *
 * The ORDER of `AREAS` is the signed order and is load-bearing:
 * Home, Inbox, Campaigns, Content, Settings. `tests/ui/nav.test.tsx` asserts
 * it, so reordering this array fails rather than quietly reshuffling the app.
 *
 * Inbox and Content are example surfaces until their rows exist, so they are
 * in the nav only when the layout says so (`RELAY_DEMO_SURFACES=show`); the
 * three that remain keep their order. Both routes still answer by URL.
 *
 * There is no Admin item. The Admin area lands in slice 3, and the dashed
 * "you only" pill the signed mock drew for it was a label on a door that did
 * not exist; it comes back as a link when there is somewhere for it to go.
 */

export type NavArea = "home" | "inbox" | "campaigns" | "content" | "settings";

const AREAS: { area: NavArea; href: string; label: string; demo?: true }[] = [
  { area: "home", href: "/", label: navCopy.home },
  { area: "inbox", href: "/inbox", label: navCopy.inbox, demo: true },
  { area: "campaigns", href: "/campaigns", label: navCopy.campaigns },
  { area: "content", href: "/content", label: navCopy.content, demo: true },
  { area: "settings", href: "/settings", label: navCopy.settings },
];

/**
 * Which area a path is in.
 *
 * `startsWith` for everything but Home, so `/campaigns/abc` still marks
 * Campaigns; Home is exact, or it would match every path in the app.
 */
function isCurrent(href: string, pathname: string): boolean {
  return href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`);
}

export function Nav({
  initials,
  hasCampaign,
  counts,
  showDemo = false,
}: {
  /**
   * Accepted and unused: the layout knows the role, and the Admin link that
   * will read it lands with the Admin area (slice 3). Kept so that arrival is
   * one line here and no change to the layout.
   */
  role: Role;
  initials: string;
  /** "New campaign" is absent from the nav until one exists (§23.1a, day one). */
  hasCampaign: boolean;
  /** A count beside an area, when it has one. Absent is not zero: it is nothing to say. */
  counts?: Partial<Record<NavArea, number>>;
  /** Whether the example surfaces (Inbox, Content) are in the nav. Off unless the environment says so. */
  showDemo?: boolean;
}) {
  const pathname = usePathname();
  const areas = AREAS.filter(({ demo }) => showDemo || demo === undefined);

  return (
    /*
      One row from `sm` up. On a phone it is two rows and never three: the
      wordmark, "New campaign" and the avatar share the first, and the area
      links form the second on their own, scrolling sideways if they must
      rather than wrapping. Nothing is hidden, reordered or put behind a menu.
    */
    <nav className="mb-card flex flex-wrap items-center gap-x-3.5 gap-y-2 rounded-card border border-line bg-panel px-4 py-2.5 text-14 font-medium shadow-nav sm:flex-nowrap sm:gap-card sm:rounded-pill sm:pl-card-rail">
      <span className="mr-2 flex items-center gap-2 text-16 font-bold">
        {/*
          The one sanctioned use of the gradient (signed tokens §1: "the
          gradient lives in the wordmark and a page-title phrase only").

          `rounded-sm` and not `rounded-input`: the mark is 22px square, and a
          12px radius on 22px reads as a circle rather than as the signed
          rounded square. `sm` is shadcn's `calc(var(--radius) - 8px)`, and
          `--radius` is generated from `radius.card`, so this is 8px derived
          from the signed tokens rather than a number written here.
        */}
        <span aria-hidden className="block h-[22px] w-[22px] rounded-sm bg-wordmark" />
        Relay
      </span>

      {/*
        The links' own row below `sm`: full width, in reading order after the
        right-hand group, and scrolling sideways rather than wrapping. The
        bottom padding is there for the current-area mark, which hangs 12px
        under its link and would otherwise be clipped by the scroll box.
      */}
      <div
        data-testid="nav-areas"
        className="order-2 flex w-full items-center gap-3.5 overflow-x-auto pb-3.5 sm:order-none sm:w-auto sm:flex-1 sm:gap-card sm:overflow-visible sm:pb-0"
      >
        {areas.map(({ area, href, label }) => {
          const current = isCurrent(href, pathname);
          const count = counts?.[area];
          return (
            <Link
              key={area}
              href={href}
              aria-current={current ? "page" : undefined}
              /*
                Hover lifts an unvisited area from `text-muted` to `text-ink` —
                the colour the current area already carries, so the cursor
                previews the destination rather than introducing a fourth text
                colour. The current area is already `text-ink`, so it is the one
                link where hover is correctly a no-op.
              */
              className={cn(
                "relative shrink-0 whitespace-nowrap focus-visible:outline-none focus-visible:ring-2",
                "transition-colors duration-micro ease-standard hover:text-ink",
                current ? "text-ink" : "text-muted",
              )}
            >
              <span data-testid="nav-label">{label}</span>
              {count === undefined ? null : (
                <span
                  data-testid="nav-count"
                  className="type-mono ml-1.5 rounded-pill bg-action px-1.5 py-0.5 text-11 text-on-action"
                >
                  {count}
                </span>
              )}
              {current ? (
                <span
                  aria-hidden
                  className="absolute inset-x-0 -bottom-3 block h-0.5 rounded-pill bg-action"
                />
              ) : null}
            </Link>
          );
        })}
      </div>

      <span className="order-1 ml-auto flex items-center gap-3.5 sm:order-none">
        {/*
          A link, because it navigates: to Start. It wears the primary pill's
          classes so it reads as the one control it is.
        */}
        {hasCampaign ? (
          <Link
            href="/campaigns/new"
            className="inline-flex items-center justify-center whitespace-nowrap rounded-pill border-control border-transparent bg-action px-4 py-2 text-13 font-semibold text-on-action transition-opacity duration-micro ease-standard hover:opacity-90 focus-visible:outline-none focus-visible:ring-2"
          >
            {navCopy.newCampaign}
          </Link>
        ) : null}
        {/*
          `role="img"`, because an `aria-label` on a bare span is dropped: the
          implicit role is generic, and a generic element takes no accessible
          name. Without it a screen reader reads the two letters out instead of
          saying whose account it is.
        */}
        <span
          role="img"
          aria-label={navCopy.account}
          className="grid h-[30px] w-[30px] shrink-0 place-items-center rounded-pill bg-soft text-12 font-semibold text-action"
        >
          {initials}
        </span>
      </span>
    </nav>
  );
}
