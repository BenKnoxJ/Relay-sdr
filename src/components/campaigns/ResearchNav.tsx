"use client";

import { useEffect, useState } from "react";

import type { ResearchPart } from "@/lib/campaigns/types";
import { researchCopy } from "@/lib/copy/research";

/**
 * Getting around "What Relay learned" (task 19): the one piece of the page
 * that runs in the browser.
 *
 * On a wide screen, a quiet list of the eleven parts that stays in view
 * ("In this research"); on a phone, one "Jump to section" control. Both have
 * Expand all and Collapse all, which open and close the eleven parts and
 * nothing inside them. Every destination is a part's own id, so a part stays
 * linkable, and following a link opens the part it lands on (and any group
 * around it) rather than landing on a closed one. Nothing here reads or
 * changes what research found: it only opens and closes what is on the page.
 */

const PARTS = Object.keys(researchCopy.parts) as ResearchPart[];
const SECTION = "details[data-research-section]";

function setAll(open: boolean): void {
  document.querySelectorAll<HTMLDetailsElement>(SECTION).forEach((section) => {
    section.open = open;
  });
}

/** How many of the parts that can open are open: all, none, or some. */
function openState(): "all" | "none" | "some" {
  const sections = [...document.querySelectorAll<HTMLDetailsElement>(SECTION)];
  const open = sections.filter((section) => section.open).length;
  return open === 0 ? "none" : open === sections.length ? "all" : "some";
}

/**
 * Follows the parts as they open and close, however that happens (a
 * summary, a link, Expand all), so each button can say it has nothing to do.
 * `toggle` does not bubble, so it is heard on the way down.
 */
function useOpenState(): "all" | "none" | "some" {
  const [state, setState] = useState<"all" | "none" | "some">("none");
  useEffect(() => {
    const update = (event?: Event) => {
      if (event === undefined || (event.target instanceof HTMLElement && event.target.matches(SECTION))) setState(openState());
    };
    update();
    document.addEventListener("toggle", update, true);
    return () => document.removeEventListener("toggle", update, true);
  }, []);
  return state;
}

/** Open whatever an id lands on: a part's own section, and every closed group or "Show" around it. */
function reveal(id: string): HTMLElement | null {
  const target = document.getElementById(id);
  if (target === null) return null;
  if (target.tagName === "SECTION") target.querySelector<HTMLDetailsElement>(SECTION)?.setAttribute("open", "");
  for (let around = target.closest("details"); around !== null; around = around.parentElement?.closest("details") ?? null) around.open = true;
  return target;
}

/**
 * Open a part and go to it. The address takes the part's id, so it can be
 * linked, but the scroll is ours: the browser's own jump to a fragment
 * measures the page before the part has opened, and stops short.
 */
function go(id: string): void {
  const target = reveal(id);
  if (target === null) return;
  window.history.pushState(null, "", `#${id}`);
  window.requestAnimationFrame(() => target.scrollIntoView?.({ block: "start" }));
}

const buttonClass =
  "type-small inline-flex min-h-6 items-center rounded-pill border border-line bg-panel px-3 py-1 font-semibold text-action focus-visible:outline-none focus-visible:ring-2 disabled:cursor-default disabled:text-muted disabled:opacity-60";

/** Expand all and Collapse all, each muted and out of the tab order when every part is already as it would leave them. */
function Buttons() {
  const state = useOpenState();
  return (
    <div className="flex flex-wrap gap-1.5">
      <button type="button" data-testid="expand-all" disabled={state === "all"} onClick={() => setAll(true)} className={buttonClass}>
        {researchCopy.expandAll}
      </button>
      <button type="button" data-testid="collapse-all" disabled={state === "none"} onClick={() => setAll(false)} className={buttonClass}>
        {researchCopy.collapseAll}
      </button>
    </div>
  );
}

export function ResearchNav({ placement }: { placement: "side" | "top" }) {
  useEffect(() => {
    // Once per page: the side list is always mounted, and only hidden on a phone.
    if (placement !== "side") return;
    // A link inside the page, or a page opened at a part: open it, then scroll once it has its full height.
    const arrive = () => {
      const id = decodeURIComponent(window.location.hash.slice(1));
      const target = id === "" ? null : reveal(id);
      if (target !== null) window.requestAnimationFrame(() => target.scrollIntoView?.({ block: "start" }));
    };
    arrive();
    window.addEventListener("hashchange", arrive);
    return () => window.removeEventListener("hashchange", arrive);
  }, [placement]);

  if (placement === "side") {
    return (
      <nav aria-label={researchCopy.inThisResearch} data-testid="research-nav" className="hidden min-w-0 wide:sticky wide:top-4 wide:block">
        <p className="type-label mb-1.5">{researchCopy.inThisResearch}</p>
        <ol className="grid border-l border-line">
          {PARTS.map((part) => (
            <li key={part}>
              <a
                href={`#${part}`}
                onClick={(event) => {
                  event.preventDefault();
                  go(part);
                }}
                className="type-small block rounded-input py-1 pl-3 text-ink hover:text-action focus-visible:outline-none focus-visible:ring-2"
              >
                {researchCopy.jump[part]}
              </a>
            </li>
          ))}
        </ol>
        <div className="mt-3">
          <Buttons />
        </div>
      </nav>
    );
  }

  return (
    <div data-testid="research-jump" className="flex min-w-0 flex-wrap items-end gap-2 wide:hidden">
      <label className="grid min-w-0 flex-1 basis-full gap-1">
        <span className="type-label">{researchCopy.jumpToSection}</span>
        <select
          data-testid="research-jump-select"
          defaultValue=""
          onChange={(event) => {
            const id = event.target.value;
            if (id === "") return;
            go(id);
            event.target.value = "";
          }}
          className="type-small min-h-6 w-full min-w-0 rounded-input border border-line bg-panel px-3 py-2 text-ink focus-visible:outline-none focus-visible:ring-2"
        >
          <option value="">{researchCopy.chooseSection}</option>
          {PARTS.map((part) => (
            <option key={part} value={part}>
              {researchCopy.parts[part]}
            </option>
          ))}
        </select>
      </label>
      <Buttons />
    </div>
  );
}
