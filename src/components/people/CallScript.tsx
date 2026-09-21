import { draftCopy } from "@/lib/copy/draft";

/**
 * A call script as the drawer shows it (Relay P5): the stored script is
 * labelled lines (`callScriptText`: open with, ask, listen for, voicemail,
 * and each objection with its answer), so each line's label is drawn quiet
 * and its words plain. What Copy copies is the stored text itself.
 */
const LABELS: readonly string[] = Object.values(draftCopy.callScript);

export function CallScript({ text }: { text: string }) {
  const lines = text.split(/\n+/).filter((line) => line.trim() !== "");
  return (
    <dl data-testid="drawer-call-script" className="type-body grid max-w-measure gap-1.5">
      {lines.map((line, index) => {
        const label = LABELS.find((candidate) => line.startsWith(candidate));
        return (
          <div key={index} className="flex flex-col gap-0.5 wide:flex-row wide:gap-2.5">
            <dt className="type-label w-28 shrink-0 pt-0.5 text-11">{label ?? ""}</dt>
            <dd className="m-0 text-ink">{label === undefined ? line : line.slice(label.length).trim()}</dd>
          </div>
        );
      })}
    </dl>
  );
}
