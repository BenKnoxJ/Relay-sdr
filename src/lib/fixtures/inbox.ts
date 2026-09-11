import {
  outreachOutputSchema,
  type OutreachOutput,
} from "../../../agents/outreach/output.schema";

import type {
  CallOutcome,
  FitWord,
  NeedsYouReason,
  RejectReason,
  ReplyLabel,
} from "@/lib/copy/inbox";

/**
 * The Inbox's data, until there are Draft, Touch, Reply and Call rows to read
 * (master doc §25, slice 1; Lane A).
 *
 * **This module is the seam.** The page calls `listQueue`, `approve`,
 * `reject`, `label` and `logCall` and knows nothing else; every component
 * below it takes what those return as props. When Lane A lands the rows and
 * the routers, a tRPC-backed implementation of these five signatures replaces
 * this file and no component changes.
 *
 * Three things this deliberately does not do. Nothing is sent: Approve moves
 * a fixture out of the queue and that is all. Nothing is spent: no model is
 * called. Nothing is written: the state lives in this module for as long as
 * the page is loaded, and a reload starts again.
 *
 * The drafts are the **real** parsed output of the signed outreach contract
 * (`agents/outreach/output.schema.ts`), not a shape invented for the card. Each
 * one is parsed at module load, so a draft the contract would reject fails
 * the build rather than rendering as a card with a quiet gap — and a live
 * outreach agent's output needs no page change to land here.
 */

export type Person = {
  name: string;
  title: string;
  company: string;
  email: string | null;
};

/**
 * What an opener reference resolves to: the fact the draft opened on, where it
 * came from and when. This is the page's view of a lookup item or an archetype
 * pain (`agents/_shared/item.schema.ts`): the text, and a source line a rep
 * can read. The item itself stays in the pack; the Draft row carries the ref
 * (§25) and the deep link back to the item is deferred (§23.1c).
 */
export type Opener = {
  id: string;
  kind: "person_fact" | "archetype_pain";
  text: string;
  /** "Careers page", "Their site", "Trade press". */
  source: string;
  /** "2 Sep". */
  date: string;
};

export type DraftItem = {
  kind: "draft";
  id: string;
  person: Person;
  /** "Email 1 of 3": which touch this is and how many the sequence has. */
  ordinal: number;
  total: number;
  /** The signed outreach output, exactly as the contract shapes it. */
  draft: OutreachOutput;
  /** The opener the draft points at, resolved. */
  opener: Opener;
  emailFound: boolean;
  fit: FitWord;
  /** When Approve would send it: "Thu", "09:00". */
  sends: { day: string; time: string };
  /** Why the draft came back to the rep, or null when it did not. */
  needsYou: NeedsYouReason | null;
};

export type ReplyItem = {
  kind: "reply";
  id: string;
  person: Person;
  /** "07:42". */
  receivedAt: string;
  /** Their message, paragraph by paragraph. */
  message: string[];
  /** The email they are replying to. */
  sent: { subject: string; sentAt: string; body: string[] };
  /** The thread in their mailbox, when the fixture has one; otherwise the card falls back to `mailto:`. */
  threadUrl: string | null;
};

export type CallItem = {
  kind: "call";
  id: string;
  person: Person;
  /** Shown large and in mono; the rep dials it themselves. */
  phone: string;
  /** What the thread did before this call was due: "opened your email twice, no reply". */
  context: string;
  /** The call touch's talking point, as the contract shapes it. */
  draft: OutreachOutput & { kind: "call" };
  opener: Opener;
};

export type QueueItem = DraftItem | ReplyItem | CallItem;

export type Queue = {
  /** Replies, then calls due, then drafts due today; needs-you drafts first among the drafts. */
  items: QueueItem[];
  counts: { replies: number; calls: number; drafts: number };
  /** When the next drafts land, for the empty state: "Thursday", "09:00". */
  nextDrafts: { day: string; time: string };
};

// ── The fixture pack ─────────────────────────────────────────────────────────

/**
 * The items the drafts open on. Every `opener.ref` on a draft below resolves
 * here or the module refuses to load — a dangling reference is an evidence
 * line with nothing behind it, and the contract's own gate on it
 * (`checkTouchLimits`, "opener-ref") needs the whole input, which the page
 * does not have.
 */
const OPENERS: Opener[] = [
  {
    id: "look-kestrel-hiring",
    kind: "person_fact",
    text: "Kestrel is hiring six night-shift dispatchers.",
    source: "Careers page",
    date: "2 Sep",
  },
  {
    id: "look-ridgeway-depot",
    kind: "person_fact",
    text: "Ridgeway opened a second depot at Avonmouth in August.",
    source: "Trade press",
    date: "28 Aug",
  },
  {
    id: "pain-missed-calls",
    kind: "archetype_pain",
    text: "Ops teams answer the phones between everything else, and the calls nobody reaches go to a competitor.",
    source: "What ops directors say",
    date: "Jul",
  },
  {
    id: "look-marlow-sunday",
    kind: "person_fact",
    text: "Marlow added a Sunday service in July.",
    source: "Their site",
    date: "20 Jul",
  },
];

/** Resolve an opener reference, or throw: a draft that points at nothing does not render as if it did. */
function resolveOpener(draft: OutreachOutput): Opener {
  const found = OPENERS.find(
    (opener) => opener.id === draft.opener.ref && opener.kind === draft.opener.kind,
  );
  if (found === undefined) {
    throw new Error(
      `the draft opens on ${draft.opener.kind} ${draft.opener.ref}, which is not in the fixture pack`,
    );
  }
  return found;
}

/**
 * Parse a draft through the signed contract and resolve what it opens on.
 *
 * `parse`, not `safeParse`: a fixture the contract refuses is a bug in the
 * fixture, and the right moment to hear about it is when the module loads.
 */
function draftOf(raw: unknown): { draft: OutreachOutput; opener: Opener } {
  const draft = outreachOutputSchema.parse(raw);
  return { draft, opener: resolveOpener(draft) };
}

/** The same, for a call touch: the card needs the talking point, so the kind is checked too. */
function callDraftOf(raw: unknown): { draft: OutreachOutput & { kind: "call" }; opener: Opener } {
  const { draft, opener } = draftOf(raw);
  if (draft.kind !== "call") throw new Error("a call in the queue carries a call draft, not a message");
  return { draft, opener };
}

// ── The fixtures, as the signed mock draws them (sections 2a, 2b, 2c) ────────

function fixtures(): QueueItem[] {
  const daniel = draftOf({
    kind: "message",
    subject: "Six dispatch hires and the phones that come with them",
    body:
      "Daniel, six night dispatchers usually means the night line is already busy, and the calls that ring out while the team is on the road are the ones that go to somebody else. Conversant keeps that line answered without the hiring, and most ops directors we work with see the difference in the first fortnight. Would ten minutes on how the night line is covered today be worth your while?",
    ask: "Would ten minutes on how the night line is covered today be worth your while?",
    opener: { ref: "look-kestrel-hiring", kind: "person_fact" },
    claims: ["i360.read-every-call"],
  });

  const sofia = draftOf({
    kind: "message",
    subject: "A second depot and the same phone line",
    body:
      "Sofia, a second depot at Avonmouth usually means the same ops team fielding twice the calls on the same line. I wrote last week about how Conversant keeps that line answered while the team is out on the yard, and I know a new site leaves little room for anything else. Is it worth a short call once Avonmouth has settled?",
    ask: "Is it worth a short call once Avonmouth has settled?",
    opener: { ref: "look-ridgeway-depot", kind: "person_fact" },
    claims: [],
  });

  const rachel = draftOf({
    kind: "message",
    subject: "The calls that ring out on a busy morning",
    body:
      "Rachel, most ops teams I speak to answer the phones between everything else, and it is the calls nobody reaches that end up with a competitor. Conversant picks up the ones that would otherwise ring out, in your name, with your answers. Would it be worth seeing a week of your own missed calls read back?",
    ask: "Would it be worth seeing a week of your own missed calls read back?",
    opener: { ref: "pain-missed-calls", kind: "archetype_pain" },
    claims: ["i360.read-every-call"],
  });

  const hannah = callDraftOf({
    kind: "call",
    talkingPoint: {
      openingLine: "Marlow added a Sunday service in July.",
      oneQuestion: "Who takes the weekend calls?",
      listenFor: "Whether the weekend line is the same team, an answering service, or nobody.",
      numberSource: "switchboard",
    },
    opener: { ref: "look-marlow-sunday", kind: "person_fact" },
    claims: [],
  });

  return [
    {
      kind: "reply",
      id: "reply-priya",
      person: {
        name: "Priya Raman",
        title: "Head of Operations",
        company: "Brightline Logistics",
        email: "priya.raman@brightline.example",
      },
      receivedAt: "07:42",
      message: [
        "Hi Ben, interesting timing, we have just taken on the Leeds depot and the phones are exactly the problem. Can you do Thursday afternoon?",
        "Priya",
      ],
      sent: {
        subject: "Two new depots and the same ops headcount",
        sentAt: "Tue 09:00",
        body: [
          "Priya, two depots on the same ops headcount usually means the phones are the first thing to give.",
          "Would a look at how the Leeds line is covered be useful?",
        ],
      },
      threadUrl: "https://outlook.office.com/mail/inbox/id/relay-fixture-priya",
    },
    {
      kind: "reply",
      id: "reply-tom",
      person: {
        name: "Tom Ashworth",
        title: "Operations Manager",
        company: "Harland Freight",
        email: "tom.ashworth@harland.example",
      },
      receivedAt: "08:15",
      message: ["Not for us right now, thanks.", "Tom"],
      sent: {
        subject: "Night calls at Harland",
        sentAt: "Mon 09:00",
        body: [
          "Tom, a night line that rings out is the one cost nobody puts on the sheet.",
          "Is it worth ten minutes on how Harland's is covered?",
        ],
      },
      threadUrl: null,
    },
    {
      kind: "call",
      id: "call-hannah",
      person: {
        name: "Hannah Lee",
        title: "Customer Service Manager",
        company: "Marlow Freight",
        email: "hannah.lee@marlow.example",
      },
      phone: "01628 000 000",
      context: "opened your email twice, no reply.",
      draft: hannah.draft,
      opener: hannah.opener,
    },
    {
      kind: "draft",
      id: "draft-daniel",
      person: {
        name: "Daniel Okoro",
        title: "Operations Director",
        company: "Kestrel Couriers",
        email: "daniel.okoro@kestrel.example",
      },
      ordinal: 1,
      total: 3,
      draft: daniel.draft,
      opener: daniel.opener,
      emailFound: true,
      fit: "strong",
      sends: { day: "Thu", time: "09:00" },
      needsYou: null,
    },
    {
      kind: "draft",
      id: "draft-sofia",
      person: {
        name: "Sofia Marsh",
        title: "Head of Operations",
        company: "Ridgeway Haulage",
        email: "sofia.marsh@ridgeway.example",
      },
      ordinal: 2,
      total: 3,
      draft: sofia.draft,
      opener: sofia.opener,
      emailFound: true,
      fit: "fair",
      sends: { day: "Thu", time: "09:00" },
      needsYou: null,
    },
    {
      kind: "draft",
      id: "draft-rachel",
      person: {
        name: "Rachel Muir",
        title: "Operations Director",
        company: "Penrose Transport",
        email: null,
      },
      ordinal: 1,
      total: 3,
      draft: rachel.draft,
      opener: rachel.opener,
      emailFound: false,
      fit: "fair",
      sends: { day: "Thu", time: "09:00" },
      needsYou: "voice",
    },
  ];
}

const NEXT_DRAFTS = { day: "Thursday", time: "09:00" } as const;

// ── Session state ────────────────────────────────────────────────────────────

/**
 * What is still in the queue. Module state on purpose: it is the session's
 * memory of what the rep has worked, and it lasts exactly as long as the page
 * does. Held as an array and never mutated in place, so every function below
 * hands back a fresh `Queue` a component can set as state.
 */
let remaining: QueueItem[] = fixtures();

const KIND_ORDER: Record<QueueItem["kind"], number> = { reply: 0, call: 1, draft: 2 };

/**
 * The signed order (§23.1b): replies, then calls due, then drafts due today,
 * with the drafts that need the rep at the top of the drafts. Within a kind
 * the fixture order stands, which is arrival order for replies and due order
 * for drafts. Stable, so the queue never reshuffles under a rep's hands.
 */
function ordered(items: QueueItem[]): QueueItem[] {
  return [...items].sort((a, b) => {
    const byKind = KIND_ORDER[a.kind] - KIND_ORDER[b.kind];
    if (byKind !== 0) return byKind;
    if (a.kind === "draft" && b.kind === "draft") {
      return Number(b.needsYou !== null) - Number(a.needsYou !== null);
    }
    return 0;
  });
}

function queueOf(items: QueueItem[]): Queue {
  const sorted = ordered(items);
  return {
    items: sorted,
    counts: {
      replies: sorted.filter((item) => item.kind === "reply").length,
      calls: sorted.filter((item) => item.kind === "call").length,
      drafts: sorted.filter((item) => item.kind === "draft").length,
    },
    nextDrafts: NEXT_DRAFTS,
  };
}

/** The queue as it stands: what is waiting, in the signed order, with its counts. */
export function listQueue(): Queue {
  return queueOf(remaining);
}

/** Take one item out of the queue and hand back what is left. Unknown ids are left alone. */
function leave(id: string): Queue {
  remaining = remaining.filter((item) => item.id !== id);
  return queueOf(remaining);
}

/**
 * Approve a draft. On fixtures the row leaves; in slice 1 this schedules the
 * send (§23.1b). `body` is the rep's inline edit, when they made one; on
 * fixtures there is nowhere for it to go, and it is accepted so the card's
 * contract is the real one.
 */
export function approve(id: string, body?: string): Queue {
  void body;
  return leave(id);
}

/** Reject a draft for one of the four signed reasons. The consequence is the copy file's to say. */
export function reject(id: string, reason: RejectReason): Queue {
  void reason;
  return leave(id);
}

/** Label a reply with one of the four signed labels. */
export function label(id: string, replyLabel: ReplyLabel): Queue {
  void replyLabel;
  return leave(id);
}

/** Log a call's outcome; `notes` is the one line Spoke asks for. */
export function logCall(id: string, outcome: CallOutcome, notes?: string): Queue {
  void outcome;
  void notes;
  return leave(id);
}

/** Put every fixture back. For tests, and for nothing else. */
export function resetQueue(): Queue {
  remaining = fixtures();
  return queueOf(remaining);
}

/** The pack the drafts open on, so a test can check a reference resolves the way the card shows it. */
export function openers(): readonly Opener[] {
  return OPENERS;
}
