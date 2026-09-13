"use client";

import { useEffect } from "react";

import { PillButton } from "@/components/PillButton";
import { reportCopy } from "@/lib/copy/report";
import { shellCopy } from "@/lib/copy/shell";

/**
 * "Print / save PDF" (task 20): the browser's own print dialog, where the rep
 * prints the pack or saves it as a PDF.
 *
 * Nothing is asked of the server and nothing is kept: what prints is the pack
 * already on the page (`ResearchReport`), which the page's print styles show
 * in place of the page itself. So cancelling leaves the page exactly as it
 * was, with the same parts open.
 *
 * While the dialog is open the document's title is the pack's, because that is
 * the name a browser gives the saved PDF. It is put back as soon as the dialog
 * closes, and the same happens for a print started from the browser's menu.
 */
export function PrintPack({ name }: { name: string }) {
  useEffect(() => {
    let before: string | null = null;
    const title = () => {
      before ??= document.title;
      document.title = `${name}${reportCopy.titleJoin}${shellCopy.appName} ${reportCopy.kind}`;
    };
    const restore = () => {
      if (before !== null) document.title = before;
      before = null;
    };
    window.addEventListener("beforeprint", title);
    window.addEventListener("afterprint", restore);
    return () => {
      window.removeEventListener("beforeprint", title);
      window.removeEventListener("afterprint", restore);
    };
  }, [name]);

  return (
    <PillButton variant="outline" data-testid="print-pack" onClick={() => window.print()} className="gap-2">
      {/* A printer, drawn in the text colour. */}
      <svg aria-hidden viewBox="0 0 16 16" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round">
        <path d="M4.5 6V2.5h7V6" />
        <rect x="2" y="6" width="12" height="5.5" rx="1.5" />
        <path d="M4.5 9.5h7v4h-7z" />
      </svg>
      {reportCopy.printAction}
    </PillButton>
  );
}
