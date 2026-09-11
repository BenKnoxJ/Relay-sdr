import { z } from "zod";

import { linkedinCopy, voiceCopy } from "@/lib/copy/settings";
import { MAX_NOTE_LINES, MAX_SAMPLES } from "@/lib/fixtures/repProfile";

/**
 * What the three Settings cards accept, and what they say when they do not
 * (master doc §23.1f; the words are §22.4's, from the copy file).
 *
 * Each check answers with the value to save or the line to show, never a zod
 * issue: the card puts the answer on its status line and nothing else reads
 * it. The schemas are exported too, so the live router can reuse them as its
 * input shapes without redoing the rules.
 */

export type Checked<T> = { ok: true; value: T } | { ok: false; message: string };

/**
 * A LinkedIn profile link and nothing else: `https://www.linkedin.com/in/…`
 * or `https://linkedin.com/in/…`, one path segment for the name, a trailing
 * slash allowed. Company pages, posts and `http:` are all refused with the
 * same plain line.
 */
export const LINKEDIN_PROFILE = /^https:\/\/(www\.)?linkedin\.com\/in\/[A-Za-z0-9%_-]+\/?$/;

export const linkedinUrlSchema = z.string().trim().regex(LINKEDIN_PROFILE, linkedinCopy.badUrl);

/** An empty field clears the link; it is not a bad link. */
export function checkLinkedinUrl(raw: string): Checked<string | null> {
  if (raw.trim() === "") return { ok: true, value: null };
  const parsed = linkedinUrlSchema.safeParse(raw);
  return parsed.success ? { ok: true, value: parsed.data } : { ok: false, message: linkedinCopy.badUrl };
}

export const voiceSampleSchema = z.string().trim().min(1, voiceCopy.empty);

/** A pasted email: not empty, and there is room for it. */
export function checkVoiceSample(raw: string, count: number): Checked<string> {
  if (count >= MAX_SAMPLES) return { ok: false, message: voiceCopy.full };
  const parsed = voiceSampleSchema.safeParse(raw);
  return parsed.success ? { ok: true, value: parsed.data } : { ok: false, message: voiceCopy.empty };
}

/**
 * How many lines a note has, as a rep would count them: a line break is a
 * line, blank lines included, and the trailing break an editor leaves at the
 * end is not one more.
 */
export function countLines(text: string): number {
  const trimmed = text.replace(/\r/g, "").replace(/\n+$/, "");
  return trimmed === "" ? 0 : trimmed.split("\n").length;
}

/** "That is 12 lines. Keep it to ten." */
export function tooManyLines(count: number): string {
  return `${voiceCopy.noteTooLongLead} ${count} ${voiceCopy.noteTooLongTail}`;
}

export const voiceNoteSchema = z.string().superRefine((text, ctx) => {
  const lines = countLines(text);
  if (lines > MAX_NOTE_LINES) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: tooManyLines(lines) });
  }
});

/** The note, at most ten lines; the answer says how many there were. */
export function checkVoiceNote(raw: string): Checked<string> {
  const parsed = voiceNoteSchema.safeParse(raw);
  if (parsed.success) return { ok: true, value: parsed.data };
  return { ok: false, message: parsed.error.issues[0]?.message ?? tooManyLines(countLines(raw)) };
}
