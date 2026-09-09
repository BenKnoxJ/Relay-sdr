"use client";

import { useId, useRef, useState } from "react";

import { Card } from "@/components/Card";
import { PillButton } from "@/components/PillButton";
import { monthNames, settingsCopy, voiceCopy } from "@/lib/copy/settings";
import {
  MAX_NOTE_LINES,
  MAX_SAMPLES,
  addSample,
  getProfile,
  removeSample,
  saveProfile,
  type RepProfile,
  type VoiceSample,
} from "@/lib/fixtures/repProfile";
import { checkVoiceNote, checkVoiceSample } from "@/lib/settings/validate";

import { FIELD, SaveLine } from "./SaveLine";

/** How many rows show before the list folds, as the mock draws it: three, then "4 more". */
const SHOWN_FOLDED = 3;

/**
 * The Your voice card (master doc §23.1f, mock section 5): the pasted emails
 * as a collapsible list with Add and Remove, the ten-line "how I write" note,
 * and the promise under it all.
 *
 * The rules, and where each lives:
 *
 *   * The list shows three rows and folds the rest behind one button with
 *     `aria-expanded`, "Show 4 more" then "Show fewer". Under three, there is
 *     no button.
 *   * Add opens a box; the email goes in on Add and the box closes, "Added"
 *     on the line. At ten, Add is gone and the line under the list says why
 *     (`voiceCopy.full`). An empty box is refused in place.
 *   * Remove is immediate, no confirm: a paste is cheap. "Removed" quietly.
 *   * The note saves on blur, guarded on a change, and is refused over ten
 *     lines with the count said plainly; the text stays in the box.
 *
 * Every change goes through the adapter and the card takes the profile it
 * hands back, so what a live repository returns is what the card shows.
 *
 * One primary control per card (§21): Add, only while its box is open.
 */
export function VoiceCard({ initial }: { initial?: RepProfile }) {
  const [profile, setProfile] = useState<RepProfile>(() => initial ?? getProfile());
  const [line, setLine] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");
  const [note, setNote] = useState(profile.voiceNote);
  const lastSavedNote = useRef(profile.voiceNote);
  const id = useId();

  const samples = profile.voiceSamples;
  const count = samples.length;
  const hidden = Math.max(0, count - SHOWN_FOLDED);
  const shown = expanded ? samples : samples.slice(0, SHOWN_FOLDED);
  const full = count >= MAX_SAMPLES;

  function onRemove(sampleId: string) {
    setProfile(removeSample(sampleId));
    setLine(voiceCopy.removed);
  }

  function onAdd() {
    const checked = checkVoiceSample(draft, count);
    if (!checked.ok) {
      setLine(checked.message);
      return;
    }
    setProfile(addSample(checked.value));
    setDraft("");
    setAdding(false);
    setLine(voiceCopy.addedLine);
  }

  function onCancel() {
    setDraft("");
    setAdding(false);
  }

  function onNoteBlur(event: React.FocusEvent<HTMLTextAreaElement>) {
    const raw = event.currentTarget.value;
    if (raw === lastSavedNote.current) return;
    const checked = checkVoiceNote(raw);
    if (!checked.ok) {
      setLine(checked.message);
      return;
    }
    setProfile(saveProfile({ voiceNote: checked.value }));
    lastSavedNote.current = raw;
    setLine(settingsCopy.saved);
  }

  const lead = `${count} ${count === 1 ? voiceCopy.email : voiceCopy.emails}`;
  const listId = `${id}-list`;
  const addId = `${id}-add`;
  const noteId = `${id}-note`;

  return (
    <Card label={settingsCopy.voice} aside={<SaveLine lead={lead} line={line} />}>
      {count === 0 ? (
        <p className="type-body mb-3 max-w-measure text-muted">{voiceCopy.none}</p>
      ) : (
        <ul id={listId} className="mb-1 divide-y divide-line">
          {shown.map((item) => (
            <SampleRow key={item.id} item={item} onRemove={onRemove} />
          ))}
        </ul>
      )}

      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 pb-3 pt-1">
        {hidden === 0 ? null : (
          <button
            type="button"
            aria-expanded={expanded}
            aria-controls={listId}
            onClick={() => setExpanded((open) => !open)}
            className="type-small rounded-pill text-muted focus-visible:outline-none focus-visible:ring-2"
          >
            {expanded ? voiceCopy.fewer : `${voiceCopy.show} ${hidden} ${voiceCopy.more}`}
          </button>
        )}
        {full ? (
          <span className="type-small text-muted">{voiceCopy.full}</span>
        ) : adding ? null : (
          <button
            type="button"
            aria-expanded={adding}
            aria-controls={addId}
            onClick={() => setAdding(true)}
            className="type-small rounded-pill font-semibold text-action focus-visible:outline-none focus-visible:ring-2"
          >
            {voiceCopy.add}
          </button>
        )}
      </div>

      {adding ? (
        <div id={addId} className="mb-4 grid gap-2">
          <label htmlFor={`${addId}-text`} className="type-small text-muted">
            {voiceCopy.addLabel}
          </label>
          <textarea
            id={`${addId}-text`}
            rows={6}
            value={draft}
            placeholder={voiceCopy.addPlaceholder}
            onChange={(event) => setDraft(event.currentTarget.value)}
            className={FIELD}
          />
          <div className="flex items-center gap-3">
            <PillButton type="button" onClick={onAdd}>
              {voiceCopy.addConfirm}
            </PillButton>
            <PillButton type="button" variant="text" onClick={onCancel}>
              {voiceCopy.addCancel}
            </PillButton>
          </div>
        </div>
      ) : null}

      <div className="grid gap-1.5">
        <div className="flex items-baseline justify-between gap-3">
          <label htmlFor={noteId} className="type-label">
            {voiceCopy.noteLabel}
          </label>
          <span className="type-small text-muted">{voiceCopy.noteHint}</span>
        </div>
        <textarea
          id={noteId}
          rows={MAX_NOTE_LINES / 2}
          value={note}
          placeholder={voiceCopy.notePlaceholder}
          onChange={(event) => setNote(event.currentTarget.value)}
          onBlur={onNoteBlur}
          className={FIELD}
        />
        <p className="type-small text-muted">{voiceCopy.promise}</p>
      </div>
    </Card>
  );
}

/**
 * One pasted email: its subject line in the ink, then the words and the day
 * in the muted small, and Remove at the end of the row. The subject is the
 * first line of what was pasted, because the box asks for it first.
 */
function SampleRow({ item, onRemove }: { item: VoiceSample; onRemove: (id: string) => void }) {
  const subject = subjectOf(item.text);
  const words = wordCount(item.text);
  return (
    <li data-testid="voice-sample" className="flex items-baseline justify-between gap-3 py-2">
      <div className="min-w-0">
        <p className="type-body truncate text-ink">{subject}</p>
        <p className="type-small text-muted">
          {words} {words === 1 ? voiceCopy.word : voiceCopy.words} {"·"} {voiceCopy.added} {dayOf(item.addedAt)}
        </p>
      </div>
      <PillButton
        type="button"
        variant="text"
        aria-label={`${voiceCopy.remove}: ${subject}`}
        onClick={() => onRemove(item.id)}
        className="py-0"
      >
        {voiceCopy.remove}
      </PillButton>
    </li>
  );
}

/** The first line with anything on it. */
export function subjectOf(text: string): string {
  return text.split("\n").map((row) => row.trim()).find((row) => row !== "") ?? "";
}

export function wordCount(text: string): number {
  return text.split(/\s+/).filter((word) => word !== "").length;
}

/** "2 Sep", from an ISO date, read as a date and not a moment so the day never shifts with the zone. */
export function dayOf(iso: string): string {
  const [, month, day] = iso.split("-").map(Number);
  const name = monthNames[(month ?? 1) - 1] ?? "";
  return `${day ?? ""} ${name}`.trim();
}
