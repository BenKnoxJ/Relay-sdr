import { cn } from "@/lib/utils";

/**
 * What an area with nothing behind it yet shows (master doc §22.7: "Empty
 * states say what happens next").
 *
 * Shape from the signed mock (`.empty`): a soft rounded tile holding one line
 * drawing, a heading, and one paragraph. Deliberately three slots and no more
 * — no button, no link, no secondary line. Every empty state in the signed
 * screens says what is coming and stops there, and a call to action on a page
 * with nothing behind it is a door to a room that does not exist.
 *
 * `icon` is a node rather than a name because there is no icon set yet
 * (§21, "icon set" is still open): each caller passes the drawing the signed
 * mock gives it, stroked in `currentColor` so it takes the tile's colour and
 * follows the theme.
 */
export function EmptyState({
  icon,
  heading,
  body,
  className,
}: {
  icon?: React.ReactNode;
  heading: string;
  body: string;
  className?: string;
}) {
  return (
    <div className={cn("px-5 py-14 text-center", className)}>
      {icon === undefined ? null : (
        <div className="mx-auto mb-3.5 grid h-14 w-14 place-items-center rounded-card bg-soft text-action">
          {icon}
        </div>
      )}
      <h2 className="type-heading mb-1.5">{heading}</h2>
      <p className="type-body mx-auto max-w-measure text-muted">{body}</p>
    </div>
  );
}
