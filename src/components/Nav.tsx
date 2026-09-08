"use client";

import type { Role } from "@prisma/client";
import Link from "next/link";
import { usePathname } from "next/navigation";

import { navCopy } from "@/lib/copy/nav";
import { cn } from "@/lib/utils";

import { PillButton } from "./PillButton";

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
 */

export type NavArea = "home" | "inbox" | "campaigns" | "content" | "settings";

const AREAS: { area: NavArea; href: string; label: string }[] = [
  { area: "home", href: "/", label: navCopy.home },
  { area: "inbox", href: "/inbox", label: navCopy.inbox },
  { area: "campaigns", href: "/campaigns", label: navCopy.campaigns },
  { area: "content", href: "/content", label: navCopy.content },
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
  role,
  initials,
  hasCampaign,
  counts,
}: {
  role: Role;
  initials: string;
  /** "New campaign" is absent from the nav until one exists (§23.1a, day one). */
  hasCampaign: boolean;
  /** A count beside an area, when it has one. Absent is not zero: it is nothing to say. */
  counts?: Partial<Record<NavArea, number>>;
}) {
  const pathname = usePathname();

  return (
    <nav className="mb-card flex items-center gap-card rounded-pill border border-line bg-panel py-2.5 pl-card-rail pr-4 text-14 font-medium shadow-nav">
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

      {AREAS.map(({ area, href, label }) => {
        const current = isCurrent(href, pathname);
        const count = counts?.[area];
        return (
          <Link
            key={area}
            href={href}
            aria-current={current ? "page" : undefined}
            className={cn(
              "relative focus-visible:outline-none focus-visible:ring-2",
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

      <span className="ml-auto flex items-center gap-3.5">
        {/*
          Admin is rendered for an admin only (§23.0: "absent from a rep's
          nav"), and is not a link: the Admin area lands in slice 3, so a link
          here would be a door to a 404. The signed mock draws it as exactly
          this — a dashed pill saying who else can see it.
        */}
        {role === "admin" ? (
          <span className="rounded-pill border border-dashed border-line px-2.5 py-1 text-12 text-muted">
            {navCopy.admin}
          </span>
        ) : null}
        {hasCampaign ? <PillButton>{navCopy.newCampaign}</PillButton> : null}
        {/*
          `role="img"`, because an `aria-label` on a bare span is dropped: the
          implicit role is generic, and a generic element takes no accessible
          name. Without it a screen reader reads the two letters out instead of
          saying whose account it is.
        */}
        <span
          role="img"
          aria-label={navCopy.account}
          className="grid h-[30px] w-[30px] place-items-center rounded-pill bg-soft text-12 font-semibold text-action"
        >
          {initials}
        </span>
      </span>
    </nav>
  );
}
