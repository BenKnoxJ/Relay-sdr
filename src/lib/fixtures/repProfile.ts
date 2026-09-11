import { z } from "zod";

/**
 * The rep's own profile behind Settings (master doc §23.1f), until there is a
 * row to read it from.
 *
 * **This module is the seam.** The three cards (LinkedIn, Your voice, Calls)
 * call `getProfile`, `saveProfile`, `addSample` and `removeSample` and know
 * nothing else; every component takes what those return as props or state.
 * When Lane A lands the rows and a router, a tRPC-backed implementation of
 * these four signatures replaces this file and no component changes.
 *
 * The schema it will need, verbatim for the STATUS.md asks: RepProfile per
 * user: linkedin_url, voice_note (text), call_by_default (bool), plus
 * voice_samples(id, user_id, text, added_at) capped at 10.
 *
 * Three things this deliberately does not do. Nothing is sent: a voice email
 * is an example, never a message. Nothing is spent: no model reads it here.
 * Nothing is written: the state lives in this module for as long as the page
 * is loaded, and a reload starts again from the fixture.
 *
 * The state is held as one frozen object and never mutated in place, so every
 * function hands back a fresh `RepProfile` a component can set as state.
 */

export type VoiceSample = {
  id: string;
  /** The whole email as pasted, subject line first. */
  text: string;
  /** ISO date, the day it was pasted. */
  addedAt: string;
};

export type RepProfile = {
  /** `https://www.linkedin.com/in/…`, or null until the rep pastes one. */
  linkedinUrl: string | null;
  /** Zero to ten pasted emails, oldest first. */
  voiceSamples: VoiceSample[];
  /** The "how I write" note, at most ten lines. */
  voiceNote: string;
  /** Include a day-3 call in new campaigns by default (§23.1d, Channels). */
  callByDefault: boolean;
};

/** The cap on pasted emails (§23.1f: "the 5 to 10 pasted emails"). */
export const MAX_SAMPLES = 10;

/** The cap on the note (§23.1f: "the ten-line 'how I write' note"). */
export const MAX_NOTE_LINES = 10;

/**
 * The shape a saved profile must have. Checked on every save, so a component
 * that skipped its own check still cannot put an eleventh email or an empty
 * one into the profile; the live repository will enforce the same at the row.
 */
export const repProfileSchema = z.object({
  linkedinUrl: z.string().nullable(),
  voiceSamples: z
    .array(z.object({ id: z.string().min(1), text: z.string().trim().min(1), addedAt: z.string() }))
    .max(MAX_SAMPLES),
  voiceNote: z.string(),
  callByDefault: z.boolean(),
});

/** A sample, sized to the mock's rows: a subject line, then a body of about the word count the mock shows. */
function sample(id: string, addedAt: string, subject: string, body: string): VoiceSample {
  return { id, addedAt, text: `${subject}\n\n${body}` };
}

// ── The fixture ──────────────────────────────────────────────────────────────

/**
 * Seven emails, as the mock's "7 emails" and its three rows plus "4 more".
 * The first three carry the mock's subject lines; the rest are the kind of
 * email a rep is proud of. Names and companies are invented.
 */
const SAMPLES: VoiceSample[] = [
  sample(
    "voice-depot-phones",
    "2026-08-14",
    "Re: Depot phones after the Leeds opening",
    [
      "Morning Sarah,",
      "Thanks for the tour on Tuesday. The bit that stuck with me was the night desk: two people, four lines, and the overflow going to whoever is nearest the phone.",
      "We looked at this for a firm about your size last year. The short version is that the calls nobody reached were about a fifth of the total, and most of them were bookings.",
      "Would it be useful if I sent over what they did about it? It is two pages, no slides.",
      "Ben",
    ].join("\n\n"),
  ),
  sample(
    "voice-night-line",
    "2026-08-20",
    "Quick one on the night line",
    [
      "Hi Tom,",
      "One question, then I will leave you alone: who takes the calls between six and eight, when the day team has gone and the night team has not started?",
      "If the answer is nobody in particular, I have something worth ten minutes.",
      "Ben",
    ].join("\n\n"),
  ),
  sample(
    "voice-following-up",
    "2026-08-26",
    "Following up from Tuesday",
    [
      "Hi Priya,",
      "You asked on Tuesday how the reporting handles a driver who calls in from the road rather than the depot. I checked, and the answer is that it does not care where the call came from; it cares who answered and how long it took.",
      "I have put a two-minute recording together showing exactly that. No need to book anything, just watch it when you have a gap.",
      "Ben",
    ].join("\n\n"),
  ),
  sample(
    "voice-sunday-service",
    "2026-08-28",
    "Re: Sunday service and the phones",
    [
      "Hi Dan,",
      "Saw the Sunday service went live this month. Congratulations, that is not a small thing to stand up.",
      "Seven days of phones is a different problem from five. Is the weekend cover the same team, or a rota?",
      "Ben",
    ].join("\n\n"),
  ),
  sample(
    "voice-not-now",
    "2026-09-01",
    "Re: not the right time",
    [
      "Hi Claire,",
      "Understood, and thanks for saying so rather than going quiet. I will come back in the new year and not before.",
      "If the November peak turns out worse than last year, my number is below.",
      "Ben",
    ].join("\n\n"),
  ),
  sample(
    "voice-second-depot",
    "2026-09-03",
    "Your second depot",
    [
      "Hi Mark,",
      "Two depots usually means two phone systems, two sets of numbers and one very tired ops manager. Is that where you are?",
      "If so, I can show you how Ridgeway put both sites on one desk. Twenty minutes, your choice of day.",
      "Ben",
    ].join("\n\n"),
  ),
  sample(
    "voice-after-the-call",
    "2026-09-05",
    "After the call this morning",
    [
      "Hi Hannah,",
      "Good to talk. Two things I said I would send: the pricing page, and the name of the person at Kestrel who ran their rollout. Both below.",
      "You asked whether the reporting works without the headsets. It does.",
      "Ben",
    ].join("\n\n"),
  ),
];

/** The profile as the fixture starts it: the mock's section 5, Ben's. */
export const FIXTURE_PROFILE: RepProfile = repProfileSchema.parse({
  linkedinUrl: "https://www.linkedin.com/in/benknoxjohnston",
  voiceSamples: SAMPLES,
  voiceNote: [
    "Short. One question per email.",
    'I never say "reach out" or "circle back".',
    "First names from the first line.",
    "British spelling.",
    'I sign off "Ben", no title.',
  ].join("\n"),
  callByDefault: true,
});

// ── The adapter ──────────────────────────────────────────────────────────────

/**
 * The profile as it stands. Module state on purpose: it is the session's
 * memory of what the rep changed, and it lasts exactly as long as the page.
 */
let current: RepProfile = FIXTURE_PROFILE;

/** A fresh copy, so nothing a component holds is the module's own object. */
function copy(profile: RepProfile): RepProfile {
  return { ...profile, voiceSamples: profile.voiceSamples.map((item) => ({ ...item })) };
}

/** The profile as it stands. */
export function getProfile(): RepProfile {
  return copy(current);
}

/**
 * Save part of the profile and hand back the whole of it. The schema is
 * checked on the merged result, so a partial that would leave the profile
 * invalid is refused as a whole: nothing is half-saved.
 */
export function saveProfile(patch: Partial<RepProfile>): RepProfile {
  current = repProfileSchema.parse({ ...current, ...patch });
  return copy(current);
}

/** Add one pasted email. Refused, by the schema, at ten or when empty. */
export function addSample(text: string, addedAt = today()): RepProfile {
  const item: VoiceSample = { id: `voice-${Date.now().toString(36)}-${current.voiceSamples.length}`, text, addedAt };
  return saveProfile({ voiceSamples: [...current.voiceSamples, item] });
}

/** Take one email out. An unknown id is left alone: the profile comes back as it was. */
export function removeSample(id: string): RepProfile {
  return saveProfile({ voiceSamples: current.voiceSamples.filter((item) => item.id !== id) });
}

/** Back to the fixture, for a test and for nothing else. */
export function resetProfile(): RepProfile {
  current = FIXTURE_PROFILE;
  return copy(current);
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}
