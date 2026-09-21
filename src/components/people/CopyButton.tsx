"use client";

import { useEffect, useState } from "react";

import { PillButton } from "@/components/PillButton";
import { outreachPeopleCopy as c } from "@/lib/copy/outreachPeople";

/**
 * Copy: puts exactly `text` on the clipboard, the words to paste into
 * LinkedIn or read on a call, and says so for a moment. The line after it is
 * a live region, so a screen reader hears "Copied" too.
 */
export function CopyButton({ text }: { text: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  useEffect(() => {
    if (state === "idle") return;
    const timer = setTimeout(() => setState("idle"), 2000);
    return () => clearTimeout(timer);
  }, [state]);
  return (
    <span className="inline-flex items-center gap-2">
      <PillButton
        variant="outline"
        data-testid="drawer-copy"
        onClick={() => {
          void navigator.clipboard
            .writeText(text)
            .then(() => setState("copied"))
            .catch(() => setState("failed"));
        }}
      >
        {state === "copied" ? c.copied : c.copy}
      </PillButton>
      <span role="status" className={state === "failed" ? "type-small text-warn" : "sr-only"}>
        {state === "copied" ? c.copied : state === "failed" ? c.copyFailed : ""}
      </span>
    </span>
  );
}
