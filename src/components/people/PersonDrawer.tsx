"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import { Chip } from "@/components/Chip";
import { PillButton } from "@/components/PillButton";
import { DraftCard } from "@/components/inbox/DraftCard";
import type { RejectReason } from "@/lib/copy/inbox";
import { outreachPeopleCopy as c } from "@/lib/copy/outreachPeople";
import type { DraftItem } from "@/lib/fixtures/inbox";
import { activityInDateOrder, copyTextOf, markButtonsFor, undoableId } from "@/lib/outreach/peopleList";
import { dayLabel, type StepId } from "@/lib/outreach/sequence";
import type { SendOffer } from "@/lib/outreach/send";
import { CALL_RESULTS, channelOf, type CallResult, type OutreachOutcome, type StepAction, type TrackedStep } from "@/lib/outreach/track";
import { SendControl } from "@/components/outreach/SendControl";
import type { PersonTrackingView, StepDraft } from "@/lib/repo/outreachTracking";

import { CallScript } from "./CallScript";
import { CopyButton } from "./CopyButton";
import { UnsavedContext, useUnsaved } from "./unsaved";

/** One person as the drawer draws them: P4's read, with each email step's draft as the Inbox card. */
export type PersonView = PersonTrackingView & {
  emailCards: Record<string, DraftItem>;
  /** What each email step's Send button says (P7); absent where the page has no mailbox to offer. */
  sendOffers?: Partial<Record<StepId, SendOffer>>;
};

/** The offers `SendControl` draws as a filled Send button; with one, Mark sent is outlined. */
const SEND_BUTTON_OFFERS: ReadonlySet<SendOffer["kind"]> = new Set(["send", "not_due", "cap", "sending"]);

/** What a send said, and which press it answers ("send:email2"). */
type SendLine = { key: string; note: string; warn: boolean };

/** A write's answer: done (with a line to show, for a send) or a line saying why not. */
type Result = Promise<{ ok: true; note?: string; warn?: boolean } | { error: string }>;

/** The server's writes the drawer calls: P4's tracking procedures and the Inbox's approve and reject. */
export type PeopleActions = {
  markStep: (input: { personId: string; step: string; kind: StepAction; callResult?: CallResult; note?: string }) => Result;
  undo: (input: { eventId: string }) => Result;
  addNote: (input: { personId: string; text: string }) => Result;
  setOutcome: (input: { personId: string; outcome: OutreachOutcome }) => Result;
  meetingBooked: (input: { personId: string }) => Result;
  setPhone: (input: { personId: string; phone: string }) => Result;
  approveDraft: (input: { draftId: string; body?: string }) => Result;
  rejectDraft: (input: { draftId: string; reason: RejectReason }) => Result;
  tryAgain: (input: { draftId: string }) => Result;
  /** Send an approved, due email from the rep's mailbox (P7). */
  sendEmail: (input: { personId: string; step: string }) => Result;
};

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * The person drawer (Relay P5; the model is Night City's campaign board
 * drawer and its step rows, the ideas and not the files).
 *
 * It slides in from the right over the People list, and the URL says who is
 * open (`?person=`), so it can be linked. Esc, the ✕ and the backdrop close
 * it; with an edited email or a note not yet saved, each of the three asks
 * first (P5c). It is a modal dialog: focus moves into it, Tab stays inside, and
 * closing it puts focus back on the row that opened it. At 390px it is the
 * full width of the screen.
 *
 * Header: who, how to reach them, the phone (Add phone), status, and the
 * outcome buttons. Then the eight steps in order, each with its state and
 * one NEXT mark on the step to do next; a step opens to its draft and the
 * buttons that are valid for it now. Then notes and activity, with Undo on
 * the latest row. Every button calls a server procedure and the page
 * re-reads; nothing here decides what is allowed.
 */
export function PersonDrawer({
  person,
  closeHref,
  actions,
  onChanged,
}: {
  /** Null when `?person=` named nobody on this campaign: the drawer says so. */
  person: PersonView | null;
  closeHref: string;
  actions: PeopleActions;
  /** After a write went through: the page reads the person again. */
  onChanged: () => void;
}) {
  const router = useRouter();
  const dialog = useRef<HTMLDivElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const personId = person?.campaignPersonId ?? null;
  const close = () => router.push(closeHref, { scroll: false });

  // Unsaved words (P5c): the fields report in, and closing over any of them asks first.
  const unsaved = useRef(new Set<string>());
  const report = useCallback((key: string, isUnsaved: boolean) => {
    if (isUnsaved) unsaved.current.add(key);
    // eslint-disable-next-line no-restricted-syntax -- a Set of field keys, not a Prisma delegate
    else unsaved.current.delete(key);
  }, []);
  const [confirming, setConfirming] = useState(false);
  // Where the rep was when the question came up: Keep editing puts them back there.
  const editingAt = useRef<HTMLElement | null>(null);
  const requestClose = useCallback(() => {
    if (unsaved.current.size === 0) {
      router.push(closeHref, { scroll: false });
      return;
    }
    editingAt.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setConfirming(true);
  }, [router, closeHref]);
  const keepEditing = useCallback(() => {
    setConfirming(false);
    const back = editingAt.current;
    // The ✕ or the backdrop had focus rather than a field: the close button is the place to come back to.
    (back !== null && back.isConnected && dialog.current?.contains(back) ? back : closeButton.current)?.focus();
  }, []);
  useEffect(() => {
    if (confirming) dialog.current?.querySelector<HTMLElement>('[data-testid="drawer-keep-editing"]')?.focus();
  }, [confirming]);

  // Focus in on open; back to the row that opened it (or what had it) on close.
  useEffect(() => {
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeButton.current?.focus();
    return () => {
      const row = personId === null ? null : document.querySelector<HTMLElement>(`[data-person-row="${CSS.escape(personId)}"]`);
      (row ?? before)?.focus();
    };
  }, [personId]);

  // Esc and Tab are the document's while the drawer is open: a write re-draws the step that had focus,
  // and focus left on the page behind must still close the drawer or come back into it.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        // Esc on the question is "keep editing"; otherwise it closes, asking first over unsaved words.
        if (confirming) keepEditing();
        else requestClose();
        return;
      }
      if (event.key !== "Tab" || dialog.current === null) return;
      const items = [...dialog.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((item) => item.offsetParent !== null || item === document.activeElement);
      const firstItem = items[0];
      const lastItem = items[items.length - 1];
      if (firstItem === undefined || lastItem === undefined) return;
      const inside = document.activeElement instanceof Node && dialog.current.contains(document.activeElement);
      if (!inside || (event.shiftKey && document.activeElement === firstItem)) {
        event.preventDefault();
        (event.shiftKey ? lastItem : firstItem).focus();
      } else if (!event.shiftKey && document.activeElement === lastItem) {
        event.preventDefault();
        firstItem.focus();
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [confirming, requestClose, keepEditing]);

  return (
    <div data-testid="person-drawer-layer" className="fixed inset-0 z-40">
      <div data-testid="person-drawer-backdrop" aria-hidden="true" onClick={requestClose} className="absolute inset-0 bg-ink opacity-40" />
      <div
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-testid="person-drawer"
        className="absolute inset-y-0 right-0 flex w-full flex-col overflow-y-auto border-l border-line bg-panel shadow-card wide:max-w-2xl"
      >
        <div className="sticky top-0 z-10 flex items-start justify-between gap-3 border-b border-line bg-panel px-card py-3">
          <h2 id={titleId} className="min-w-0 truncate text-20 font-semibold text-ink">
            {person?.name ?? c.drawerLabel}
          </h2>
          <button
            ref={closeButton}
            type="button"
            data-testid="person-drawer-close"
            aria-label={c.close}
            onClick={requestClose}
            className="rounded-pill px-2 text-16 leading-none text-muted outline-none hover:text-ink focus-visible:ring-2"
          >
            <span aria-hidden="true">✕</span>
          </button>
        </div>
        {confirming ? (
          <div role="alert" data-testid="drawer-unsaved" className="mx-card mt-3 grid gap-2 rounded-input bg-warn-bg px-3 py-2">
            <p className="type-small text-warn">{c.unsavedPrompt}</p>
            <div className="flex flex-wrap items-center gap-2">
              <PillButton variant="outline" data-testid="drawer-keep-editing" onClick={keepEditing}>
                {c.keepEditing}
              </PillButton>
              <PillButton variant="text" data-testid="drawer-close-anyway" onClick={close}>
                {c.closeAnyway}
              </PillButton>
            </div>
          </div>
        ) : null}
        {person === null ? (
          <p data-testid="person-drawer-missing" className="type-body px-card py-5 text-muted">
            {c.notFound}
          </p>
        ) : (
          <UnsavedContext.Provider value={report}>
            <DrawerBody key={person.campaignPersonId} person={person} actions={actions} onChanged={onChanged} />
          </UnsavedContext.Provider>
        )}
      </div>
    </div>
  );
}

function DrawerBody({ person, actions, onChanged }: { person: PersonView; actions: PeopleActions; onChanged: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // What a send just did ("Sent from your mailbox.", "They replied, so this wasn't sent."), or why it
  // was refused: shown beside that step's Send, where the rep is looking, and announced from the top.
  const [note, setNote] = useState<SendLine | null>(null);
  const t = person.tracking;
  const nextStep = t.nextDue?.step ?? null;
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set(nextStep === null ? [] : [nextStep]));

  /** Run one write, once at a time; the page re-reads when it went through. */
  async function run(key: string, work: () => Result): Promise<boolean> {
    if (busy !== null) return false;
    setBusy(key);
    setError(null);
    setNote(null);
    try {
      const result = await work();
      if ("error" in result) {
        if (key.startsWith("send:")) setNote({ key, note: result.error, warn: true });
        else setError(result.error);
        return false;
      }
      if (result.note !== undefined) setNote({ key, note: result.note, warn: result.warn === true });
      onChanged();
      return true;
    } catch {
      setError(c.cannotChange);
      return false;
    } finally {
      setBusy(null);
    }
  }

  const toggle = (step: string) => setOpen((now) => (now.has(step) ? new Set([...now].filter((id) => id !== step)) : new Set([...now, step])));
  const who = [person.title, person.company].filter((part) => part !== "").join(" · ");
  const personId = person.campaignPersonId;

  return (
    <div className="grid gap-5 px-card py-4">
      <p role="alert" data-testid="drawer-alert" className={error === null ? "sr-only" : "type-small rounded-input bg-warn-bg px-3 py-2 text-warn"}>
        {error}
      </p>
      <p role="status" data-testid="drawer-send-status" className="sr-only">
        {note?.note}
      </p>

      <section data-testid="drawer-header" className="grid gap-2">
        {who === "" ? null : <p className="type-body text-ink">{who}</p>}
        <p className="type-small flex flex-wrap items-center gap-x-3 gap-y-1 text-muted">
          {person.email === "" ? <span>{c.noEmail}</span> : <span data-testid="drawer-email" className="break-all">{person.email}</span>}
          {person.linkedinUrl === null ? null : (
            <a href={person.linkedinUrl} target="_blank" rel="noopener noreferrer" data-testid="drawer-linkedin" className="rounded-input text-action underline outline-none focus-visible:ring-2">
              {c.linkedin} <span aria-hidden="true">↗</span>
              <span className="sr-only"> {c.opensNewTab}</span>
            </a>
          )}
        </p>
        <PhoneLine phone={person.phone} busy={busy !== null} onSave={(phone) => run("phone", () => actions.setPhone({ personId, phone }))} />
        <div className="flex flex-wrap items-center gap-2">
          <Chip tone={t.status === "replied" || t.status === "meeting" ? "ok" : "default"}>{c.status[t.status]}</Chip>
          <span className="type-small font-mono text-muted">
            {t.progress.done}/{t.progress.total} {c.progress}
          </span>
          {t.meetingOn === null ? null : (
            <span data-testid="drawer-meeting" className="type-small text-ink">
              {c.meetingOn} {dayLabel(t.meetingOn)}
            </span>
          )}
          {t.outcome === null ? null : (
            <span data-testid="drawer-outcome" className="type-small text-ink">
              {c.closedAs} {c.outcome[t.outcome.outcome]}, {dayLabel(t.outcome.on)}
            </span>
          )}
        </div>
        {t.personActions.includes("meeting") || t.personActions.includes("outcome") ? (
          <div data-testid="drawer-outcomes" role="group" aria-label={c.outcomeLabel} className="flex flex-wrap gap-2">
            {t.personActions.includes("meeting") ? (
              <PillButton variant="outline" data-testid="drawer-meeting-booked" disabled={busy !== null} onClick={() => void run("meeting", () => actions.meetingBooked({ personId }))}>
                {c.meetingBooked}
              </PillButton>
            ) : null}
            {t.personActions.includes("outcome") ? (
              <>
                <PillButton variant="outline" data-testid="drawer-not-interested" disabled={busy !== null} onClick={() => void run("outcome", () => actions.setOutcome({ personId, outcome: "not_interested" }))}>
                  {c.notInterested}
                </PillButton>
                <PillButton variant="outline" data-testid="drawer-wrong-person" disabled={busy !== null} onClick={() => void run("outcome", () => actions.setOutcome({ personId, outcome: "wrong_person" }))}>
                  {c.wrongPerson}
                </PillButton>
              </>
            ) : null}
          </div>
        ) : null}
      </section>

      <section aria-labelledby={`${personId}-sequence`}>
        <h3 id={`${personId}-sequence`} className="type-label mb-2">
          {c.sequenceLabel}
        </h3>
        <ol data-testid="drawer-steps" className="grid gap-2">
          {t.steps.map((step) => (
            <StepItem
              key={step.id}
              step={step}
              next={step.id === nextStep}
              open={open.has(step.id)}
              onToggle={() => toggle(step.id)}
              draft={person.drafts[step.id] ?? null}
              card={person.emailCards[step.id] ?? null}
              offer={person.sendOffers?.[step.id as StepId] ?? null}
              sendNote={note?.key === `send:${step.id}` ? note : null}
              busy={busy}
              run={run}
              personId={personId}
              actions={actions}
            />
          ))}
        </ol>
      </section>

      <Notes notes={person.notes} busy={busy !== null} onAdd={(text) => run("note", () => actions.addNote({ personId, text }))} />
      <Activity events={person.events} busy={busy} onUndo={(eventId) => void run(`undo:${eventId}`, () => actions.undo({ eventId }))} />
    </div>
  );
}

function PhoneLine({ phone, busy, onSave }: { phone: string | null; busy: boolean; onSave: (phone: string) => Promise<boolean> }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(phone ?? "");
  const inputId = useId();
  if (!editing) {
    return (
      <p data-testid="drawer-phone" className="type-small flex flex-wrap items-center gap-2 text-muted">
        <span>{c.phone}:</span>
        {phone === null ? null : <span className="font-mono text-ink">{phone}</span>}
        <PillButton variant="text" data-testid="drawer-phone-edit" onClick={() => setEditing(true)} disabled={busy}>
          {phone === null ? c.addPhone : c.editPhone}
        </PillButton>
      </p>
    );
  }
  return (
    <form
      data-testid="drawer-phone-form"
      className="flex flex-wrap items-center gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        void onSave(value).then((ok) => ok && setEditing(false));
      }}
    >
      <label htmlFor={inputId} className="type-small text-muted">
        {c.phone}
      </label>
      <input
        id={inputId}
        type="tel"
        data-testid="drawer-phone-input"
        value={value}
        maxLength={40}
        autoFocus
        onChange={(event) => setValue(event.currentTarget.value)}
        className="type-body w-48 rounded-input border-control border-line bg-ground px-2 py-1 text-ink outline-none focus-visible:ring-2"
      />
      <PillButton type="submit" variant="outline" data-testid="drawer-phone-save" disabled={busy}>
        {busy ? c.saving : c.savePhone}
      </PillButton>
      <PillButton variant="text" onClick={() => setEditing(false)} disabled={busy}>
        {c.cancel}
      </PillButton>
    </form>
  );
}

const MARK_LABEL: Record<Exclude<StepAction, "done">, string> = {
  sent: c.markSent,
  accepted: c.markAccepted,
  declined: c.markDeclined,
  replied: c.markReplied,
  bounced: c.markBounced,
};

/** A step's state in words: when it was done and what came back, or when it is due. */
function stateLine(step: TrackedStep): { text: string; warn: boolean } {
  const call = channelOf(step.id) === "call";
  if (step.state === "done" && step.doneOn !== null) {
    const done = `${call ? c.calledOn : c.sentOn} ${dayLabel(step.doneOn)}${step.callResult === null ? "" : `, ${c.callResult[step.callResult].toLowerCase()}`}`;
    return { text: step.response === null ? done : `${done} · ${c.response[step.response.kind]} ${dayLabel(step.response.on)}`, warn: false };
  }
  if (step.state === "skipped") return { text: c.stepState.skipped, warn: false };
  if (step.state === "waiting") return { text: step.waitingFor === null ? c.stepState.waiting : c.waitingFor[step.waitingFor], warn: false };
  if (step.state === "paused") return { text: c.stepState.paused, warn: false };
  const due = step.due === null ? "" : ` ${dayLabel(step.due)}`;
  if (step.state === "overdue") return { text: `${c.stepState.overdue}${due}`, warn: true };
  return { text: `${step.state === "due" ? c.stepState.due : c.due}${due}`, warn: false };
}

function StepItem({
  step,
  next,
  open,
  onToggle,
  draft,
  card,
  offer,
  sendNote,
  busy,
  run,
  personId,
  actions,
}: {
  step: TrackedStep;
  next: boolean;
  open: boolean;
  onToggle: () => void;
  draft: StepDraft | null;
  card: DraftItem | null;
  offer: SendOffer | null;
  sendNote: SendLine | null;
  busy: string | null;
  run: (key: string, work: () => Result) => Promise<boolean>;
  personId: string;
  actions: PeopleActions;
}) {
  const panelId = useId();
  const channel = channelOf(step.id as StepId);
  const line = stateLine(step);
  const buttons = markButtonsFor(step, draft?.state ?? null);
  const waitingApproval = channel === "email" && step.nextActions.includes("sent") && !buttons.includes("sent");
  const [calling, setCalling] = useState(false);
  const label = c.step[step.id as StepId];

  return (
    <li data-testid="drawer-step" data-step={step.id} data-state={step.state} data-next={next ? "true" : undefined} className={`rounded-input border ${next ? "border-action bg-soft" : "border-line"}`}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        data-testid="drawer-step-toggle"
        onClick={onToggle}
        className="flex w-full flex-wrap items-center gap-x-2.5 gap-y-1 rounded-input px-3 py-2.5 text-left outline-none focus-visible:ring-2"
      >
        <Chip>{c.channel[channel]}</Chip>
        <span className="text-15 font-semibold text-ink">{label}</span>
        {next ? (
          <span data-testid="drawer-step-next" className="rounded-pill bg-action px-2 py-0.5 text-11 font-semibold uppercase text-on-action">
            {c.nextBadge}
          </span>
        ) : null}
        <span data-testid="drawer-step-state" className={`type-small ml-auto ${line.warn ? "font-semibold text-warn" : "text-muted"}`}>
          {line.text}
        </span>
      </button>

      {open ? (
        <div id={panelId} data-testid="drawer-step-panel" className="grid gap-3 border-t border-line px-3 py-3">
          <StepDraftView channel={channel} draft={draft} card={card} busy={busy} run={run} actions={actions} />

          {channel === "email" && (offer !== null || sendNote !== null) ? (
            <div data-testid="drawer-send" className="grid gap-2">
              {/* Read out by the status line at the top of the drawer; shown here, beside the button that was pressed. */}
              {sendNote === null ? null : (
                <p aria-hidden="true" data-testid="drawer-send-note" className={`type-small rounded-input px-3 py-2 ${sendNote.warn ? "bg-warn-bg text-warn" : "bg-soft text-ink"}`}>
                  {sendNote.note}
                </p>
              )}
              {offer === null ? null : <SendControl offer={offer} busy={busy === `send:${step.id}`} onSend={() => void run(`send:${step.id}`, () => actions.sendEmail({ personId, step: step.id }))} />}
            </div>
          ) : null}

          {buttons.length === 0 && !waitingApproval ? null : (
            <div data-testid="drawer-step-marks" className="flex flex-wrap items-center gap-2">
              {buttons.map((kind) =>
                kind === "done" ? (
                  <PillButton key={kind} variant="outline" data-testid="drawer-mark-done" aria-expanded={calling} disabled={busy !== null} onClick={() => setCalling((now) => !now)}>
                    {c.markCallDone}
                  </PillButton>
                ) : (
                  <PillButton
                    key={kind}
                    // One primary per card (§21): on an email Relay can send, Send is it and Mark sent (for one sent by hand) steps back.
                    variant={kind === "sent" && !(channel === "email" && offer !== null && SEND_BUTTON_OFFERS.has(offer.kind)) ? "primary" : "outline"}
                    data-testid={`drawer-mark-${kind}`}
                    disabled={busy !== null}
                    onClick={() => void run(`mark:${step.id}`, () => actions.markStep({ personId, step: step.id, kind }))}
                  >
                    {MARK_LABEL[kind]}
                  </PillButton>
                ),
              )}
              {waitingApproval ? (
                <span data-testid="drawer-approve-first" className="type-small text-muted">
                  {c.approveFirst}
                </span>
              ) : null}
            </div>
          )}

          {calling && buttons.includes("done") ? (
            <CallDoneForm busy={busy !== null} onSave={(callResult, note) => run(`mark:${step.id}`, () => actions.markStep({ personId, step: step.id, kind: "done", callResult, ...(note === "" ? {} : { note }) }))} />
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

function StepDraftView({
  channel,
  draft,
  card,
  busy,
  run,
  actions,
}: {
  channel: ReturnType<typeof channelOf>;
  draft: StepDraft | null;
  card: DraftItem | null;
  busy: string | null;
  run: (key: string, work: () => Result) => Promise<boolean>;
  actions: PeopleActions;
}) {
  if (draft === null) return <p className="type-small text-muted">{c.noDraft}</p>;
  const tryAgain = (
    <TryAgain draft={draft} busy={busy} onTry={() => void run(`try:${draft.id}`, () => actions.tryAgain({ draftId: draft.id }))} />
  );

  if (draft.state === "rejected") {
    return (
      <p data-testid="drawer-draft-rejected" className="type-small text-muted">
        {c.draftRejected}. {draft.redrafting ? c.redrafting : null}
      </p>
    );
  }

  if (channel === "email") {
    // Undecided: the Inbox's own card, so approving here and there is one piece of code.
    if (card !== null && draft.state !== "approved") {
      return (
        <div data-testid="drawer-email-card" className="grid gap-2">
          <DraftCard
            item={card}
            deciding={busy === `approve:${draft.id}` ? "approve" : busy === `reject:${draft.id}` ? "reject" : null}
            onApprove={(id, body) => void run(`approve:${id}`, () => actions.approveDraft({ draftId: id, ...(body === undefined ? {} : { body }) }))}
            onReject={(id, reason) => void run(`reject:${id}`, () => actions.rejectDraft({ draftId: id, reason }))}
          />
          {tryAgain}
        </div>
      );
    }
    return (
      <div data-testid="drawer-email-approved" className="grid gap-1.5">
        <Chip tone="ok" className="w-fit">
          {c.draftApproved}
        </Chip>
        {draft.subject === null ? null : <p className="text-15 font-semibold text-ink">{draft.subject}</p>}
        <Paragraphs text={draft.body ?? ""} />
        {/* Unsent, it can still go by hand (P7): the words to paste, greeting and sign-off included. */}
        {draft.body === null ? null : <CopyButton text={emailCopyText(draft.body, card)} />}
      </div>
    );
  }

  const text = copyTextOf(draft);
  return (
    <div data-testid="drawer-message" className="grid gap-2">
      {draft.state === "failed" || (draft.state === "needs_you" && draft.body === null) ? (
        <p className="type-small text-warn">{c.notWritten}</p>
      ) : draft.state === "needs_you" ? (
        <p className="type-small text-warn">{c.heldForYou}</p>
      ) : null}
      {text === "" ? null : channel === "call" ? <CallScript text={text} /> : <Paragraphs text={text} testId="drawer-message-text" />}
      <div className="flex flex-wrap items-center gap-2">
        {text === "" ? null : <CopyButton text={text} />}
        {tryAgain}
      </div>
    </div>
  );
}

/** An approved email as the rep would paste it: the card's greeting, the body, the card's sign-off. */
function emailCopyText(body: string, card: DraftItem | null): string {
  const envelope = card?.envelope;
  return [envelope?.greeting ?? "", body.trim(), envelope?.signOff ?? ""].filter((part) => part.trim() !== "").join("\n\n");
}

function TryAgain({ draft, busy, onTry }: { draft: StepDraft; busy: string | null; onTry: () => void }) {
  if (draft.state !== "failed" && draft.state !== "needs_you") return null;
  if (draft.redrafting) return <span data-testid="drawer-redrafting" className="type-small text-muted">{c.redrafting}</span>;
  if (!draft.canTryAgain) {
    return <span className="type-small text-muted">{c.triedEnough}</span>;
  }
  return (
    <PillButton variant="outline" data-testid="drawer-try-again" className="w-fit" disabled={busy !== null} onClick={onTry}>
      {busy === `try:${draft.id}` ? c.tryingAgain : c.tryAgain}
    </PillButton>
  );
}

function Paragraphs({ text, testId }: { text: string; testId?: string }) {
  return (
    <div data-testid={testId} className="type-body max-w-measure text-ink">
      {text.split(/\n{2,}/).map((paragraph, index) => (
        <p key={index} className="mb-2 whitespace-pre-line last:mb-0">
          {paragraph}
        </p>
      ))}
    </div>
  );
}

function CallDoneForm({ busy, onSave }: { busy: boolean; onSave: (result: CallResult, note: string) => Promise<boolean> }) {
  const [result, setResult] = useState<CallResult | null>(null);
  const [note, setNote] = useState("");
  useUnsaved("call-note", note.trim() !== "");
  const noteId = useId();
  const legendId = useId();
  return (
    <form
      data-testid="drawer-call-form"
      className="grid gap-2.5 rounded-input border border-line bg-ground px-3 py-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (result !== null) void onSave(result, note.trim());
      }}
    >
      <div role="radiogroup" aria-labelledby={legendId} className="flex flex-wrap gap-2">
        <span id={legendId} className="type-label w-full">
          {c.callResultLabel}
        </span>
        {CALL_RESULTS.map((option) => (
          <label key={option} className={`type-small inline-flex cursor-pointer items-center gap-1.5 rounded-pill border px-2.5 py-1 ${result === option ? "border-action bg-soft text-action" : "border-line text-ink"}`}>
            <input type="radio" name="call-result" value={option} data-testid={`drawer-call-${option}`} checked={result === option} onChange={() => setResult(option)} className="accent-action" />
            {c.callResult[option]}
          </label>
        ))}
      </div>
      <label htmlFor={noteId} className="type-label">
        {c.callNote}
      </label>
      <textarea
        id={noteId}
        data-testid="drawer-call-note"
        rows={2}
        maxLength={2000}
        value={note}
        onChange={(event) => setNote(event.currentTarget.value)}
        className="type-body w-full resize-y rounded-input border-control border-line bg-panel px-3 py-2 text-ink outline-none focus-visible:ring-2"
      />
      <PillButton type="submit" data-testid="drawer-call-save" className="w-fit" disabled={busy || result === null}>
        {busy ? c.saving : c.saveCall}
      </PillButton>
    </form>
  );
}

function Notes({ notes, busy, onAdd }: { notes: PersonView["notes"]; busy: boolean; onAdd: (text: string) => Promise<boolean> }) {
  const [text, setText] = useState("");
  useUnsaved("note", text.trim() !== "");
  const fieldId = useId();
  const headingId = useId();
  return (
    <section data-testid="drawer-notes" aria-labelledby={headingId}>
      <h3 id={headingId} className="type-label mb-2">
        {c.notesLabel}
      </h3>
      {notes.length === 0 ? (
        <p className="type-small mb-2 text-muted">{c.noNotes}</p>
      ) : (
        <ul className="mb-3 grid gap-2">
          {notes.map((note) => (
            <li key={note.eventId} data-testid="drawer-note" className="rounded-input border border-line px-3 py-2">
              <p className="type-small mb-0.5 text-muted">
                {dayLabel(note.happenedOn)}
                {note.step === null ? "" : ` · ${c.step[note.step as StepId] ?? ""}`}
              </p>
              <p className="type-body whitespace-pre-line text-ink">{note.note}</p>
            </li>
          ))}
        </ul>
      )}
      <form
        className="grid gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (text.trim() === "") return;
          void onAdd(text).then((ok) => ok && setText(""));
        }}
      >
        <label htmlFor={fieldId} className="sr-only">
          {c.noteField}
        </label>
        <textarea
          id={fieldId}
          data-testid="drawer-note-field"
          rows={2}
          maxLength={2000}
          value={text}
          placeholder={c.noteField}
          onChange={(event) => setText(event.currentTarget.value)}
          className="type-body w-full resize-y rounded-input border-control border-line bg-ground px-3 py-2 text-ink outline-none focus-visible:ring-2"
        />
        <PillButton type="submit" variant="outline" data-testid="drawer-note-add" className="w-fit" disabled={busy || text.trim() === ""}>
          {c.addNote}
        </PillButton>
      </form>
    </section>
  );
}

function activityLine(event: PersonView["events"][number]): string {
  if (event.kind === "note") return c.activity.note;
  if (event.kind === "meeting") return c.activity.meeting;
  if (event.kind === "outcome") return event.outcome === null ? c.activity.outcome : `${c.activity.outcome}: ${c.outcome[event.outcome]}`;
  const step = event.step === null ? "" : (c.step[event.step as StepId] ?? "");
  const what = event.kind === "undo" ? "" : c.activity[event.kind];
  return `${step} ${what}${event.callResult === null ? "" : `, ${c.callResult[event.callResult].toLowerCase()}`}`.trim();
}

function Activity({ events, busy, onUndo }: { events: PersonView["events"]; busy: string | null; onUndo: (eventId: string) => void }) {
  const rows = activityInDateOrder(events);
  const undoable = undoableId(events);
  const headingId = useId();
  return (
    <section data-testid="drawer-activity" aria-labelledby={headingId}>
      <h3 id={headingId} className="type-label mb-2">
        {c.activityLabel}
      </h3>
      {rows.length === 0 ? (
        <p className="type-small text-muted">{c.noActivity}</p>
      ) : (
        <ol className="grid gap-1.5">
          {rows.map((event) => (
            <li key={event.id} data-testid="drawer-activity-row" data-kind={event.kind} className="type-small flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5">
              <span className="font-mono text-muted">{dayLabel(event.happenedOn)}</span>
              <span className="text-ink">{activityLine(event)}</span>
              {event.id === undoable ? (
                <PillButton variant="text" data-testid="drawer-undo" disabled={busy !== null} onClick={() => onUndo(event.id)} className="py-0 text-action">
                  {busy === `undo:${event.id}` ? c.undoing : c.undo}
                </PillButton>
              ) : null}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
