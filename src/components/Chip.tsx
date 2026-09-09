import { cn } from "@/lib/utils";

/**
 * One word of state, in a pill (signed tokens §4, "state badges").
 *
 * Three tones and no more, because the signed palette has one accent:
 * `default` is the quiet outline, `ok` is the accent on its soft background,
 * `warn` is the separate semantic colour that §21 is explicit is not a second
 * accent. There is deliberately no "bad" or "danger" tone — nothing in the
 * signed screens has one, and adding it here would be adding to the palette.
 */
export type ChipTone = "default" | "ok" | "warn";

const TONES: Record<ChipTone, string> = {
  default: "border-line bg-ground text-muted",
  ok: "border-transparent bg-soft text-action",
  warn: "border-transparent bg-warn-bg text-warn",
};

export function Chip({
  tone = "default",
  className,
  children,
}: {
  tone?: ChipTone;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-pill border px-2.5 py-0.5 text-12 font-medium",
        TONES[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}
