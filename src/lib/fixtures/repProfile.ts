import { z } from "zod";

/**
 * The rep's own profile behind Settings (master doc §23.1f), until there is a
 * row to read it from.
 *
 * **This module is the seam.** The cards (LinkedIn, Your voice, Calls) call
 * `getProfile`, `saveProfile`, `addSample` and `removeSample` and know nothing
 * else; every component takes what those return as props or state. When Lane
 * A lands the rows and a router, a tRPC-backed implementation of these four
 * signatures replaces this file and no component changes.
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
 * The fixture is EMPTY on purpose. It used to carry a profile link, seven
 * pasted emails and a "how I write" note for one particular rep, and every
 * rep who opened Settings read them as their own. Until a row exists, the
 * honest starting point is nothing: an empty link field, no emails, an empty
 * note. `callByDefault` keeps its default because Start reads nothing from it
 * yet and the Calls card is not on the page.
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

/** What a saved voice is (outreach v2.1): the samples and the note, whole. Null when saved, else the line to show. */
export type PersistVoice = (voice: { samples: { text: string; addedAt: string }[]; howIWrite: string }) => Promise<string | null>;

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

// ── The fixture ──────────────────────────────────────────────────────────────

/** The profile as the fixture starts it: nobody's, and empty. */
export const FIXTURE_PROFILE: RepProfile = repProfileSchema.parse({
  linkedinUrl: null,
  voiceSamples: [],
  voiceNote: "",
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
