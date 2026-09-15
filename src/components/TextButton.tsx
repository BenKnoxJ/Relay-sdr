import Link from "next/link";

import { cn } from "@/lib/utils";

/**
 * The quiet in-line control (final MVP pass): accent text, semibold, no
 * border and no fill, for a small action or a way in that sits inside a
 * card ("Show", "Change", "Open the full research"). One class list, drawn
 * as a button or as a link, so the same words look the same everywhere.
 */
const CLASSES = "type-small inline-flex min-h-6 items-center font-semibold text-action focus-visible:outline-none focus-visible:ring-2 disabled:opacity-60";

export function TextButton({ className, type = "button", ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button type={type} className={cn(CLASSES, className)} {...props} />;
}

export function TextLink({ className, ...props }: React.ComponentProps<typeof Link>) {
  return <Link className={cn(CLASSES, className)} {...props} />;
}
