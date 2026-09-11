import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Inbox } from "@/components/inbox/Inbox";
import { listQueue, resetQueue } from "@/lib/fixtures/inbox";

/**
 * One snapshot per signed Inbox state, in both themes: 2a draft selected, 2b
 * reply selected, 2c call selected, and empty.
 *
 * Read for what it is, as `tests/ui/shell.test.tsx` says of its own: jsdom
 * applies no stylesheet, so the two themes produce the same markup unless a
 * component branches on the theme itself — which nothing here does, and which
 * is the point. What holds the pages to the tokens is the token discipline
 * check in the shell test (it reads every component under `src/components`,
 * this directory included) and the side-by-side screenshots in the pull
 * request; this catches an unintended change to the markup or the copy.
 */

const THEMES = ["light", "dark"] as const;

const STATES = {
  "2a-draft-selected": () => {
    render(<Inbox />);
    // The mock's 2a selects Daniel, the first draft that does not need the rep.
    fireEvent.click(screen.getAllByTestId("queue-row")[4] as HTMLElement);
  },
  "2b-reply-selected": () => {
    render(<Inbox />);
  },
  "2c-call-selected": () => {
    render(<Inbox />);
    fireEvent.click(screen.getAllByTestId("queue-row")[2] as HTMLElement);
  },
  empty: () => {
    const { nextDrafts } = listQueue();
    render(<Inbox initial={{ items: [], counts: { replies: 0, calls: 0, drafts: 0 }, nextDrafts }} />);
  },
};

beforeEach(() => {
  resetQueue();
});

afterEach(() => {
  document.documentElement.removeAttribute("data-theme");
});

/** `useId` output depends on render order; see the shell test for why it is masked. */
const stable = (html: string) => html.replace(/_r_[0-9a-z]+_/g, "_id_");

describe.each(THEMES)("the Inbox in %s", (theme) => {
  for (const [name, show] of Object.entries(STATES)) {
    it(`renders ${name} as signed`, () => {
      document.documentElement.setAttribute("data-theme", theme);
      show();
      expect(stable(document.body.innerHTML)).toMatchSnapshot();
    });
  }
});
