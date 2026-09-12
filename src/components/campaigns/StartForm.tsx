"use client";

import { useRouter } from "next/navigation";
import Link from "next/link";
import { useState } from "react";

import { Card } from "@/components/Card";
import { PageHeader } from "@/components/PageHeader";
import { PillButton } from "@/components/PillButton";
import {
  countryName,
  SIZE_UNITS,
  type BriefDraft,
  type GuessableField,
  type Product,
  type StartResult,
  type StartSubmission,
} from "@/lib/campaigns/start";
import type { BriefFields, BriefScope, Place, SizeUnit } from "@/lib/campaigns/types";
import { campaignsCopy, startCopy } from "@/lib/copy/campaigns";
import { cn } from "@/lib/utils";

/**
 * Start (§23.1d, mock 3d): two steps on one page, no wizard.
 *
 * **Every field is a picker**, except the two that are the rep's own words
 * (Who, and the optional customers question) and the terms under Who exactly,
 * which are the rep's own words too. A field the sentence did not cover is
 * drawn dashed with the default already chosen, so the rep can see what Relay
 * guessed rather than what it asked.
 *
 * **Who exactly** is research's scope (v3.2, note 28): countries beyond the
 * region, places, kinds of organisation, size, roles to reach and to leave out.
 * It starts empty and nothing in it is guessed: only what the rep adds limits
 * the research.
 *
 * Nothing is spent here. "Start research" makes the campaign and asks for its
 * research, then moves the rep to the campaign page.
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

/** Enter adds the term, rather than doing nothing; an IME's own Enter is left alone. */
function onEnter(add: () => void) {
  return (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
    event.preventDefault();
    add();
  };
}

/** One term the rep added, with a way to take it off again. */
function TermChip({ text, onRemove, removeName }: { text: string; onRemove: () => void; removeName: string }) {
  return (
    <li data-testid="term-chip" className="inline-flex items-center gap-1.5 rounded-pill bg-soft py-1 pl-3 pr-2 text-13 text-action">
      {text}
      <button
        type="button"
        aria-label={removeName}
        onClick={onRemove}
        /*
          A 24px square to press (WCAG 2.5.8), drawn inside the chip as the
          mark was: the negative margins give back the extra size, so the chip
          keeps its height and nearly its width.
        */
        className="-my-1 -mr-1.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-pill text-muted hover:text-ink focus-visible:outline-none focus-visible:ring-2"
      >
        {startCopy.removeMark}
      </button>
    </li>
  );
}

/** A list of the rep's own terms: type one, add it, take it off again. */
function TermList({
  label,
  placeholder,
  values,
  onChange,
}: {
  label: string;
  placeholder: string;
  values: string[];
  onChange: (values: string[]) => void;
}) {
  const [text, setText] = useState("");
  const add = () => {
    const value = text.trim();
    if (value === "") return;
    if (!values.some((existing) => existing.toLowerCase() === value.toLowerCase())) onChange([...values, value]);
    setText("");
  };

  return (
    <div>
      <div className="flex gap-chips">
        <input
          aria-label={label}
          value={text}
          placeholder={placeholder}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={onEnter(add)}
          className={pickerClass(false)}
        />
        <PillButton variant="outline" onClick={add}>
          {startCopy.add}
        </PillButton>
      </div>
      {values.length === 0 ? null : (
        <ul className="mt-2 flex flex-wrap gap-chips">
          {values.map((value) => (
            <TermChip
              key={value}
              text={value}
              removeName={`${startCopy.remove} ${value}`}
              onRemove={() => onChange(values.filter((existing) => existing !== value))}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

/** Places: a name, and the other names a page may use for it. */
function PlaceList({ places, onChange }: { places: Place[]; onChange: (places: Place[]) => void }) {
  const [name, setName] = useState("");
  const [aliases, setAliases] = useState("");
  const add = () => {
    const value = name.trim();
    if (value === "") return;
    if (!places.some((place) => place.name.toLowerCase() === value.toLowerCase())) {
      const other = aliases
        .split(",")
        .map((alias) => alias.trim())
        .filter((alias) => alias !== "");
      onChange([...places, { name: value, aliases: other }]);
    }
    setName("");
    setAliases("");
  };

  return (
    <div>
      <div className="grid gap-chips wide:grid-cols-[1fr_1fr_auto]">
        <input
          aria-label={startCopy.fieldPlaces}
          value={name}
          placeholder={startCopy.placePlaceholder}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={onEnter(add)}
          className={pickerClass(false)}
        />
        <input
          aria-label={startCopy.aliasesLabel}
          value={aliases}
          placeholder={startCopy.aliasesPlaceholder}
          onChange={(event) => setAliases(event.target.value)}
          onKeyDown={onEnter(add)}
          className={pickerClass(false)}
        />
        <PillButton variant="outline" onClick={add}>
          {startCopy.add}
        </PillButton>
      </div>
      {places.length === 0 ? null : (
        <ul className="mt-2 flex flex-wrap gap-chips">
          {places.map((place) => (
            <TermChip
              key={place.name}
              text={
                place.aliases.length === 0
                  ? place.name
                  : `${place.name} (${campaignsCopy.alsoCalled} ${place.aliases.join(", ")})`
              }
              removeName={`${startCopy.remove} ${place.name}`}
              onRemove={() => onChange(places.filter((existing) => existing !== place))}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

/** A whole number typed into a size box, or undefined for a blank one. */
function wholeNumber(text: string): number | undefined {
  if (text.trim() === "") return undefined;
  const value = Number(text);
  return Number.isInteger(value) && value >= 0 ? value : undefined;
}

export function StartForm({
  sentence,
  prefilled,
  products,
  regions,
  howMany,
  howLong,
  mailboxConnected,
  onStart,
}: {
  /** What the rep typed on Home. Empty when they came straight to this page. */
  sentence: string;
  /**
   * The card, already pre-filled from the sentence by the server.
   *
   * A prop and not a call, because §23.1d runs the pre-fill once, on Start:
   * re-reading the sentence is a navigation back to this page with the new
   * sentence on it, which is what the Edit button does.
   *
   * The rep's Calls default (Settings §23.1f) is already in here. The chip is
   * a default and not a lock, so the rep's tap on it wins for this campaign
   * and the profile is left as it was.
   */
  prefilled: BriefDraft;
  products: Product[];
  /** The countries on offer, as ISO codes; each is shown by its name. */
  regions: readonly string[];
  howMany: readonly number[];
  howLong: readonly number[];
  mailboxConnected: boolean;
  /** Makes the campaign and asks for its research; comes back with where to go or a line to show. */
  onStart: (submission: StartSubmission) => Promise<StartResult>;
}) {
  const router = useRouter();
  const [said, setSaid] = useState(sentence);
  const [editing, setEditing] = useState(sentence.trim() === "");
  const [draft, setDraft] = useState<BriefDraft>(prefilled);
  const [sizeUnit, setSizeUnit] = useState<SizeUnit>(prefilled.scope.size?.unit ?? "employees");
  const [sizeMin, setSizeMin] = useState(prefilled.scope.size?.min?.toString() ?? "");
  const [sizeMax, setSizeMax] = useState(prefilled.scope.size?.max?.toString() ?? "");
  // Minted once per card: a second press of Start sends the same id, and the
  // server answers it with the campaign the first press made.
  const [startRequestId] = useState(() => crypto.randomUUID());
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const guessed = (field: GuessableField) => draft.guessed.includes(field);
  const product = products[0];

  const set = <K extends keyof BriefFields>(field: K, value: BriefFields[K]) =>
    setDraft((current) => ({
      ...current,
      [field]: value,
      // Choosing a field is the rep answering it, so it stops being a guess.
      guessed: current.guessed.filter((name) => name !== field),
    }));

  const setScope = (patch: Partial<BriefScope>) =>
    setDraft((current) => ({ ...current, scope: { ...current.scope, ...patch } }));

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

  const min = wholeNumber(sizeMin);
  const max = wholeNumber(sizeMax);
  const sizeBackwards = min !== undefined && max !== undefined && min > max;

  const start = async () => {
    if (pending) return;
    setPending(true);
    setError(null);
    const brief: BriefFields = {
      product: draft.product,
      motion: draft.motion,
      who: draft.who,
      region: draft.region,
      howMany: draft.howMany,
      weeks: draft.weeks,
      channels: draft.channels,
      scope: {
        ...draft.scope,
        extraCountries: draft.scope.extraCountries.filter((code) => code !== draft.region),
        // A size is only a constraint when the rep typed an end to it.
        size:
          min === undefined && max === undefined
            ? null
            : { unit: sizeUnit, ...(min === undefined ? {} : { min }), ...(max === undefined ? {} : { max }) },
      },
      existingCustomers: draft.existingCustomers,
    };
    try {
      const result = await onStart({ startRequestId, brief });
      if ("id" in result) {
        router.push(`/campaigns/${result.id}?started=1`);
        return;
      }
      setError(result.error);
    } catch {
      setError(startCopy.cannotStart);
    }
    setPending(false);
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
              onChange={(event) => {
                const code = event.target.value;
                set("region", code);
                // The region is never also an extra country.
                setScope({ extraCountries: draft.scope.extraCountries.filter((other) => other !== code) });
              }}
              className={pickerClass(guessed("region"))}
            >
              {regions.map((code) => (
                <option key={code} value={code}>
                  {countryName(code)}
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

        {/* Who exactly (research v3.2 scope): empty until the rep adds to it. */}
        <div data-testid="who-exactly" className="mt-5 border-t border-line pt-4">
          <p className="type-label mb-1">{startCopy.fieldWhoExactly}</p>
          <p className="type-small mb-3 text-muted">{startCopy.whoExactlyHint}</p>

          <div className="grid gap-grid wide:grid-cols-2">
            <Field label={startCopy.fieldAlsoInclude}>
              <div className="flex flex-wrap gap-chips">
                {regions
                  .filter((code) => code !== draft.region)
                  .map((code) => {
                    const on = draft.scope.extraCountries.includes(code);
                    return (
                      <button
                        key={code}
                        type="button"
                        data-testid="country-chip"
                        aria-pressed={on}
                        onClick={() =>
                          setScope({
                            extraCountries: on
                              ? draft.scope.extraCountries.filter((other) => other !== code)
                              : [...draft.scope.extraCountries, code],
                          })
                        }
                        className={chipClass(on)}
                      >
                        {countryName(code)}
                      </button>
                    );
                  })}
              </div>
            </Field>

            <Field label={startCopy.fieldSize} hint={sizeBackwards ? startCopy.sizeBackwards : undefined}>
              <div className="flex gap-chips">
                <input
                  aria-label={startCopy.sizeFrom}
                  inputMode="numeric"
                  value={sizeMin}
                  placeholder={startCopy.sizeFrom}
                  onChange={(event) => setSizeMin(event.target.value)}
                  className={pickerClass(false)}
                />
                <input
                  aria-label={startCopy.sizeTo}
                  inputMode="numeric"
                  value={sizeMax}
                  placeholder={startCopy.sizeTo}
                  onChange={(event) => setSizeMax(event.target.value)}
                  className={pickerClass(false)}
                />
                <select
                  aria-label={startCopy.sizeUnitLabel}
                  value={sizeUnit}
                  onChange={(event) => setSizeUnit(event.target.value as SizeUnit)}
                  className={pickerClass(false)}
                >
                  {SIZE_UNITS.map((unit) => (
                    <option key={unit} value={unit}>
                      {campaignsCopy.sizeUnits[unit]}
                    </option>
                  ))}
                </select>
              </div>
            </Field>

            <Field label={startCopy.fieldPlaces} wide>
              <PlaceList places={draft.scope.places} onChange={(places) => setScope({ places })} />
            </Field>

            <Field label={startCopy.fieldOrgTypes} wide>
              <TermList
                label={startCopy.fieldOrgTypes}
                placeholder={startCopy.orgTypePlaceholder}
                values={draft.scope.orgTypes}
                onChange={(orgTypes) => setScope({ orgTypes })}
              />
            </Field>

            <Field label={startCopy.fieldRolesInclude}>
              <TermList
                label={startCopy.fieldRolesInclude}
                placeholder={startCopy.rolePlaceholder}
                values={draft.scope.rolesInclude}
                onChange={(rolesInclude) => setScope({ rolesInclude })}
              />
            </Field>

            <Field label={startCopy.fieldRolesExclude}>
              <TermList
                label={startCopy.fieldRolesExclude}
                placeholder={startCopy.rolePlaceholder}
                values={draft.scope.rolesExclude}
                onChange={(rolesExclude) => setScope({ rolesExclude })}
              />
            </Field>

            <Field label={startCopy.fieldCustomers} hint={startCopy.customersHint} wide>
              <textarea
                aria-label={startCopy.fieldCustomers}
                value={draft.existingCustomers}
                onChange={(event) => set("existingCustomers", event.target.value)}
                className={pickerClass(false)}
              />
            </Field>
          </div>
        </div>

        <div className="mt-5 flex flex-wrap items-center gap-3 border-t border-line pt-4">
          <PillButton
            disabled={!mailboxConnected || pending || sizeBackwards || draft.who.trim() === ""}
            onClick={() => void start()}
          >
            {pending ? startCopy.starting : startCopy.start}
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
        {error === null ? null : (
          <p role="alert" data-testid="start-error" className="type-small mt-3 text-warn">
            {error}
          </p>
        )}
      </Card>
    </>
  );
}
