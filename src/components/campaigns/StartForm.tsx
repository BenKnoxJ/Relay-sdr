"use client";

import { useRouter } from "next/navigation";
import Link from "next/link";
import { useState } from "react";

import { Card } from "@/components/Card";
import { PageHeader } from "@/components/PageHeader";
import { PillButton } from "@/components/PillButton";
import { campaignsCopy, startCopy } from "@/lib/copy/campaigns";
import type { BriefDraft, BriefFields, Product } from "@/lib/fixtures/campaigns";
import { cn } from "@/lib/utils";

/**
 * Start (§23.1d, mock 3d): two steps on one page, no wizard.
 *
 * **Every field is a picker.** That is the amendment of 2026-09-07 and it is
 * the reason there is not a single free-text input here except Who, which the
 * signed card draws as text because it is the rep's own words. A field the
 * sentence did not cover is drawn dashed with the default already chosen, so
 * the rep can see what Relay guessed rather than what it asked.
 *
 * Two things are absent on purpose: a campaign name (Relay names it, and the
 * rename lives on the campaign page) and a mailbox picker (Settings owns it).
 *
 * Nothing is spent here. "Start research" moves the rep to the campaign page
 * in Researching and says that nothing was bought or sent.
 */

const MOTIONS: [BriefFields["motion"], string][] = [
  ["direct", startCopy.motionDirect],
  ["channel", startCopy.motionChannel],
];

const CHANNELS: [BriefFields["channels"][number], string][] = [
  ["email", startCopy.channelEmail],
  ["linkedin", startCopy.channelLinkedin],
  ["calls", startCopy.channelCalls],
];

/** A field's frame. Dashed is Relay's guess, solid is the rep's sentence. */
function Field({
  label,
  hint,
  wide = false,
  children,
}: {
  label: string;
  hint?: string;
  wide?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div data-testid="start-field" className={wide ? "col-span-full" : undefined}>
      <p className="type-label mb-1">{label}</p>
      {children}
      {hint === undefined ? null : <p className="type-small mt-1 text-muted">{hint}</p>}
    </div>
  );
}

function pickerClass(guessed: boolean): string {
  return cn(
    "type-small w-full rounded-input border-control bg-panel px-3 py-2",
    "focus-visible:outline-none focus-visible:ring-2",
    guessed ? "border-dashed border-muted" : "border-line",
  );
}

/** The dashed frame a guessed field wears, around a row of chips. */
function guessedFrame(guessed: boolean): string | undefined {
  return guessed ? "rounded-input border-control border-dashed border-muted p-2" : undefined;
}

function chipClass(on: boolean): string {
  return cn(
    "rounded-pill border px-3 py-1 text-13",
    "transition-colors duration-micro ease-standard",
    "focus-visible:outline-none focus-visible:ring-2",
    on ? "border-transparent bg-soft text-action" : "border-line bg-panel text-muted",
  );
}

export function StartForm({
  sentence,
  prefilled,
  products,
  regions,
  howMany,
  howLong,
  mailboxConnected,
}: {
  /** What the rep typed on Home. Empty when they came straight to this page. */
  sentence: string;
  /**
   * The card, already pre-filled from the sentence by the server.
   *
   * A prop and not a call, because §23.1d runs the pre-fill once, on Start:
   * re-reading the sentence is a navigation back to this page with the new
   * sentence on it, which is what the Edit button does. It also keeps the
   * fixtures module, and the research contract it parses, off the browser.
   *
   * The rep's Calls default (Settings §23.1f) is already in here: the page
   * reads it once, on the server, and hands it to the pre-fill. The chip is a
   * default and not a lock, so the rep's tap on it wins for this campaign and
   * the profile is left as it was.
   */
  prefilled: BriefDraft;
  products: Product[];
  regions: readonly string[];
  howMany: readonly number[];
  howLong: readonly number[];
  mailboxConnected: boolean;
}) {
  const router = useRouter();
  const [said, setSaid] = useState(sentence);
  const [editing, setEditing] = useState(sentence.trim() === "");
  const [draft, setDraft] = useState<BriefDraft>(prefilled);
  const guessed = (field: keyof BriefFields) => draft.guessed.includes(field);
  const product = products[0];

  const set = <K extends keyof BriefFields>(field: K, value: BriefFields[K]) =>
    setDraft((current) => ({
      ...current,
      [field]: value,
      // Choosing a field is the rep answering it, so it stops being a guess.
      guessed: current.guessed.filter((name) => name !== field),
    }));

  const toggleChannel = (channel: BriefFields["channels"][number]) => {
    // Email is always on (§23.1d): the toggle is drawn, and it does not toggle.
    if (channel === "email") return;
    set(
      "channels",
      draft.channels.includes(channel)
        ? draft.channels.filter((name) => name !== channel)
        : [...draft.channels, channel],
    );
  };

  return (
    <>
      <PageHeader title={startCopy.title} note={startCopy.note} />

      <Card className="mx-auto max-w-[760px]">
        <p className="type-label mb-1">{startCopy.question}</p>
        {/* Step 1: the sentence, and one way back into it (mock 3d). */}
        <div className="mb-4 flex items-center gap-2 rounded-pill border-control border-line bg-ground py-1.5 pl-4 pr-1.5">
          {editing ? (
            <input
              aria-label={startCopy.question}
              value={said}
              autoFocus
              placeholder={startCopy.placeholder}
              onChange={(event) => setSaid(event.target.value)}
              className="type-small flex-1 bg-transparent focus-visible:outline-none"
            />
          ) : (
            <span className="type-small flex-1">{said}</span>
          )}
          <PillButton
            variant="text"
            className="px-2.5"
            onClick={() => {
              // Re-reading the sentence re-pre-fills the card, which is the
              // only moment §23.1d lets the pre-fill run. It happens where the
              // pre-fill lives, on the server, so this is a navigation.
              if (!editing) {
                setEditing(true);
                return;
              }
              // An unchanged sentence would push the same url, leave `key`
              // alone, and so leave this component mounted in edit mode for
              // ever. Nothing to re-read, so just close it.
              if (said === sentence) {
                setEditing(false);
                return;
              }
              router.push(`/campaigns/new?said=${encodeURIComponent(said)}`);
            }}
          >
            {editing ? startCopy.readIt : startCopy.edit}
          </PillButton>
        </div>
        <p className="type-small mb-3 text-muted">{startCopy.understood}</p>

        <div className="grid gap-grid wide:grid-cols-2">
          <Field
            label={startCopy.fieldProduct}
            hint={
              product === undefined
                ? undefined
                : `${startCopy.factsUpdated} ${product.factsUpdated}, ${startCopy.factsVersion} ${product.factsVersion}. ${startCopy.factsMore}`
            }
          >
            <select
              aria-label={startCopy.fieldProduct}
              value={draft.product}
              onChange={(event) => set("product", event.target.value)}
              className={pickerClass(false)}
            >
              {products.map((option) => (
                <option key={option.id} value={option.name}>
                  {option.name}
                </option>
              ))}
            </select>
          </Field>

          <Field label={startCopy.fieldMotion} hint={guessed("motion") ? startCopy.guessedHint : undefined}>
            <div className={cn("flex gap-chips", guessedFrame(guessed("motion")))}>
              {MOTIONS.map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  data-testid="motion-chip"
                  aria-pressed={draft.motion === value}
                  onClick={() => set("motion", value)}
                  className={chipClass(draft.motion === value)}
                >
                  {label}
                </button>
              ))}
            </div>
          </Field>

          <Field label={startCopy.fieldWho} wide>
            <textarea
              aria-label={startCopy.fieldWho}
              value={draft.who}
              onChange={(event) => set("who", event.target.value)}
              placeholder={startCopy.placeholder}
              className={pickerClass(false)}
            />
          </Field>

          <Field label={startCopy.fieldRegion}>
            <select
              aria-label={startCopy.fieldRegion}
              value={draft.region}
              onChange={(event) => set("region", event.target.value)}
              className={pickerClass(guessed("region"))}
            >
              {regions.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </Field>

          <Field
            label={startCopy.fieldHowManyHowLong}
            hint={guessed("howMany") || guessed("weeks") ? startCopy.guessedHint : undefined}
          >
            <div className="flex gap-chips">
              <select
                aria-label={startCopy.people}
                value={draft.howMany}
                onChange={(event) => set("howMany", Number(event.target.value))}
                className={pickerClass(guessed("howMany"))}
              >
                {howMany.map((count) => (
                  <option key={count} value={count}>
                    {count} {startCopy.people}
                  </option>
                ))}
              </select>
              <select
                aria-label={startCopy.weeks}
                value={draft.weeks}
                onChange={(event) => set("weeks", Number(event.target.value))}
                className={pickerClass(guessed("weeks"))}
              >
                {howLong.map((count) => (
                  <option key={count} value={count}>
                    {count} {startCopy.weeks}
                  </option>
                ))}
              </select>
            </div>
          </Field>

          <Field label={startCopy.fieldChannels} hint={startCopy.channelsHint} wide>
            <div className={cn("flex gap-chips", guessedFrame(guessed("channels")))}>
              {CHANNELS.map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  data-testid="channel-chip"
                  aria-pressed={draft.channels.includes(value)}
                  disabled={value === "email"}
                  onClick={() => toggleChannel(value)}
                  className={chipClass(draft.channels.includes(value))}
                >
                  {label}
                </button>
              ))}
            </div>
          </Field>
        </div>

        <div className="mt-5 flex flex-wrap items-center gap-3 border-t border-line pt-4">
          <PillButton
            disabled={!mailboxConnected}
            onClick={() => router.push(`/campaigns/${draft.landsOn}?started=1`)}
          >
            {startCopy.start}
          </PillButton>
          {mailboxConnected ? (
            <span className="type-small text-muted">{startCopy.startNote}</span>
          ) : (
            <span data-testid="connect-first" className="type-small text-muted">
              {startCopy.connectFirst}{" "}
              <Link href="/settings" className="text-action underline">
                {startCopy.connectLink}
              </Link>
            </span>
          )}
        </div>
      </Card>

      <p className="type-small mt-3 text-center text-muted">{campaignsCopy.toastStarted}</p>
    </>
  );
}
