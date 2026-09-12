"use server";

import { redirect } from "next/navigation";

import { SENTENCE_MAX } from "@/lib/shell";

/**
 * What Home's brief box submits to.
 *
 * The sentence goes to Start, which reads it into the card the rep confirms
 * (§23.1d). Nothing is written here: a campaign is made by Start, from the
 * brief the rep checked, and never from a sentence alone.
 *
 * Returns the line to show under the box, which is `useActionState`'s state;
 * on a sentence worth reading it does not return at all, it redirects.
 */
export async function startBrief(_previous: string | null, form: FormData): Promise<string | null> {
  // There is no error boundary under `(app)`, so an action that rejects
  // replaces the whole page with Next's default error screen, and the
  // browser's own `required` lets a single space through. Nothing to say about
  // a blank sentence, so nothing is said: the box stays as it was.
  const sentence = String(form.get("sentence") ?? "").trim();
  if (sentence === "" || sentence.length > SENTENCE_MAX) return null;

  redirect(`/campaigns/new?said=${encodeURIComponent(sentence)}`);
}
