import type { EvidenceQuote, OutreachInput } from "../../../agents/outreach/input.schema";
import { checkTouchLimits, type MessageDraft, type OutreachOutput } from "../../../agents/outreach/output.schema";
import type { NeverSayFile } from "@/lib/facts/neverSay";
import { neverSayIssues } from "@/lib/facts/neverSay";

import { genderedPronouns, isBinaryAsk, mentionsPrice, namesProduct } from "./messageChecks";

/**
 * Outreach v2.1 §6: the deterministic gates on a first email, after the model.
 *
 * Tier A findings reject the draft and go back to the writer once, with the
 * findings; a second failure parks it as Needs you. Tier B is advice on the
 * card and never blocks. Every finding is in the rep's words, because the card
 * shows it.
 *
 * What is deliberately not here: taste. A draft that passes can still be a
 * poor email, which is what the rep's review and the sendability panel are
 * for. These gates hold what code can hold: shape, the tell list, provenance
 * and template repetition.
 */

export type Finding = { rule: string; text: string };
export type GateResult = { tierA: Finding[]; tierB: Finding[] };

/**
 * A draft already written in this campaign, as the cohort gates read it. `personId` is who it was written for:
 * the repetition gates count people, not drafts (M2 fix 2), so one colleague's two touches are one person.
 */
export type CohortDraft = { body: string; ask: string; sameAccount: boolean; personId: string };

export type GateContext = {
  /** The product's name as the rep says it; always allowed in a body. */
  productNames: readonly string[];
  /** The rep's own name. */
  repName: string;
  /** The campaign's other drafts, newest first. */
  cohort: readonly CohortDraft[];
  /** The product's never-say list, so a touch cannot say what the pack may not (M2). */
  neverSay?: Pick<NeverSayFile, "entries">;
};

// ---------------------------------------------------------------------------
// Text helpers

const SENTENCE = /[^.?!]+[.?!]+|[^.?!]+$/g;

export function sentences(text: string): string[] {
  return (text.replace(/\s+/g, " ").trim().match(SENTENCE) ?? []).map((s) => s.trim()).filter((s) => s.length > 0);
}

function paragraphs(text: string): string[] {
  return text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

/** Lower-case words, a possessive read as its noun: "July's" is July. */
function words(text: string): string[] {
  return (text.toLowerCase().replace(/’/g, "'").match(/[a-z0-9£$%']+/g) ?? []).map((word) => word.replace(/'s$/, ""));
}

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A phrase as whole words, case-insensitive. */
function hasPhrase(text: string, phrase: string): boolean {
  return new RegExp(`(^|[^a-z0-9])${escape(phrase.toLowerCase())}($|[^a-z0-9])`).test(text.toLowerCase());
}

/**
 * A tell-list entry in a text (M2, 23 Sep 2026).
 *
 * `hasPhrase` is whole-word and exact, which let two whole families of tell
 * through in the 22 Sep cohort. A multi-word entry now matches as a
 * substring, so "would it help if I sent" is caught inside a longer sentence
 * whatever punctuation sits in it, and a single word matches its ordinary
 * English stems, so "streamline" catches "streamlined" and "empower" catches
 * "empowers". Nothing here matches a *prefix*: "outreaching" is not "out".
 */
export function hasTell(text: string, phrase: string): boolean {
  const wanted = phrase.trim().toLowerCase();
  if (wanted === "") return false;
  const haystack = text.toLowerCase().replace(/[\u2019]/g, "'").replace(/\s+/g, " ");
  if (/\s/.test(wanted)) return haystack.includes(wanted.replace(/\s+/g, " "));
  return new RegExp(`(^|[^a-z0-9])${escape(wanted)}(?:s|es|d|ed|ing|ly|ment|ments)?($|[^a-z0-9])`).test(haystack);
}

// ---------------------------------------------------------------------------
// Tier A: shape and wording

/** v2.1 §5 rule 4: a time or meeting ask, a meeting length or a calendar link. */
const TIME_ASK = [
  /\b\d+\s*(?:-|to)?\s*(?:\d+\s*)?(?:min|mins|minute|minutes)\b/i,
  /\b(?:fifteen|twenty|thirty|ten|five)[- ]minutes?\b/i,
  /\bhalf an hour\b/i,
  /\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i,
  /\b(?:next|this) week\b/i,
  /\btomorrow\b/i,
  /\bcalend(?:ar|ly)\b/i,
  /\bin (?:your|the) diary\b/i,
  /\bbook (?:a|some|in a) (?:call|meeting|time|slot|demo)\b/i,
  /\b(?:grab|find) (?:a|some) time\b/i,
  /\bsend (?:you )?(?:an? )?invite\b/i,
];

/** v2.1 §6: the two-sentence antithesis and the "not X, but Y" turn. */
const ANTITHESIS = [
  /\b(?:isn't|is not|aren't|are not|wasn't|was not|it's not|it is not)\b[^.?!]{0,80}[.;,]\s*(?:it's|it is|they're|they are|this is|that's|that is)\b/i,
  /\bnot (?:just |only |simply )?[^.,?!]{1,50}, but\b/i,
  /\bnot [^.?!]{1,40}\.\s+(?:it's|it is)\b/i,
];

/** Non-British spellings, a fixed list (§7). */
const US_SPELLINGS = [
  "organize", "organized", "organizing", "organization", "organizations", "prioritize", "prioritized", "analyze", "analyzed", "analyzing",
  "optimize", "optimized", "optimizing", "optimization", "realize", "realized", "recognize", "recognized", "specialize", "specialized",
  "customize", "customized", "apologize", "standardize", "standardized", "summarize", "utilize", "maximize", "minimize", "emphasize",
  "color", "colors", "behavior", "behaviors", "favor", "favorite", "honor", "labor", "center", "centers", "centered", "defense", "catalog",
  "modeling", "traveling", "canceled", "fulfill", "enroll", "judgment",
];

/**
 * The paragraphs finding, as an instruction the corrective call can follow to the letter (M2 fix 1): which
 * paragraph, and the sentence the new one starts at. "Break it up" left the redraft guessing, and in the
 * 23 Sep cohort a four-sentence Email 1 came back as one block anyway.
 */
function splitParagraphText(paragraph: string): string {
  const list = sentences(paragraph);
  const at = list[Math.ceil(list.length / 2)] ?? "";
  const opening = at.split(/\s+/).slice(0, 8).join(" ");
  return `A paragraph runs to ${list.length} sentences; a phone screen wants three at most. Split this paragraph: start a new paragraph at "${opening}${opening === at ? "" : "…"}".`;
}

function shapeFindings(draft: MessageDraft, input: OutreachInput, lexicon: readonly string[]): Finding[] {
  const found: Finding[] = [];
  const body = draft.body;
  const count = sentences(body).length;
  if (count < 3 || count > 5) found.push({ rule: "sentences", text: `This is ${count} sentence${count === 1 ? "" : "s"}; a first email is 3 to 5.` });
  const long = paragraphs(body).find((p) => sentences(p).length > 3);
  if (long !== undefined) found.push({ rule: "paragraphs", text: splitParagraphText(long) });
  if (/https?:\/\/|www\.[a-z]/i.test(body)) found.push({ rule: "link", text: "A first email carries no link." });
  if (body.includes("!") || (draft.subject ?? "").includes("!")) found.push({ rule: "exclamation", text: "No exclamation marks." });
  const askLike = `${draft.ask} ${body}`;
  if (TIME_ASK.some((pattern) => pattern.test(askLike))) {
    found.push({ rule: "time-ask", text: "It asks for a time, a meeting length or a calendar slot; ask whether it is relevant instead." });
  }
  if (ANTITHESIS.some((pattern) => pattern.test(body))) found.push({ rule: "antithesis", text: "It uses the \"it isn't X, it's Y\" turn; say the point plainly." });
  const tells = lexicon.filter((phrase) => hasTell(`${draft.subject ?? ""} ${body}`, phrase));
  if (tells.length > 0) found.push({ rule: "tells", text: `It uses ${tells.map((t) => `"${t}"`).join(", ")}, which reads as a template.` });
  const us = US_SPELLINGS.filter((word) => new RegExp(`\\b${word}\\b`, "i").test(body));
  if (us.length > 0) found.push({ rule: "spelling", text: `American spelling: ${us.join(", ")}. Use British English.` });
  // v2.1 §2: the greeting and the sign-off are Relay's envelope; the body is what sits between them.
  const first = input.person.firstName.trim();
  const opensWithName = first !== "" && new RegExp(`^\\s*${escape(first)}\\s*[,!.]`, "i").test(body);
  const signsOff = /\n\s*(?:best|thanks|many thanks|cheers|regards|kind regards|best wishes)[,.!]?\s*(?:\n.*)?$/i.test(body);
  if (/^\s*(?:hi|hello|hey|dear|morning|good morning|afternoon)\b/i.test(body) || opensWithName || signsOff) {
    found.push({ rule: "envelope", text: "The greeting and the sign-off are added for you; the body starts with the first sentence and ends with the question." });
  }
  return found;
}

// ---------------------------------------------------------------------------
// Tier A: provenance (v2.1 §6, as corrected)
//
// Every externally factual named entity and every number the model
// introduces must resolve to the lookup, the pack or the live facts. The
// structured values the input already carries are valid as they are. This is
// deliberately not "every capitalised word is a proper noun": a single word
// that only starts a sentence is a sentence, not a name.

/** Capitalised words that are ordinary English whatever their position. */
const ORDINARY = new Set(
  "i i'm i've i'd i'll we we're we've our you you're your yours they their it it's its this that these those the a an and but or if when while what which who how why where there here is are was were be been has have had do does did can could would should will may might most many much more some any each every all no not one two three hi hello thanks thank best regards kind cheers mr mrs ms dr".split(
    " ",
  ),
);

/** Calendar words and the country Relay writes from: never a claim about anyone. */
const CALENDAR = new Set(
  "january february march april may june july august september october november december spring summer autumn winter uk british britain england scotland wales ireland london".split(" "),
);

/**
 * Where a touch is sent and how the rep and the prospect talk: never a claim about anyone (M2 fix 1). A call
 * script says "I sent a note on LinkedIn", and holding that as an unsourced name parked Emlyn's call in the
 * 23 Sep cohort. Multi-word names are read before single words, so "Microsoft Teams" goes whole.
 */
export const CHANNEL_WORDS = ["microsoft teams", "microsoft outlook", "google meet", "linkedin", "inmail", "outlook", "teams", "zoom", "whatsapp", "slack", "gmail", "email", "e-mail"] as const;

function withoutChannels(entity: string): string {
  let out = entity.toLowerCase();
  for (const channel of CHANNEL_WORDS) out = out.replace(new RegExp(`(^|[^a-z0-9])${escape(channel)}($|[^a-z0-9])`, "g"), "$1 $2");
  return out;
}

/** The names and values the input already carries, which a body may always use, as written. */
function allowedValues(input: OutreachInput, context: GateContext): string[] {
  return [
    // The rep's own name and company: the call opener and the voicemail say who is ringing.
    input.sender.firstName,
    input.sender.company,
    input.person.name,
    input.person.firstName,
    input.person.title,
    input.person.company,
    input.person.domain ?? "",
    input.person.city ?? "",
    input.account.company,
    input.account.domain ?? "",
    input.buyerRole?.title ?? "",
    input.pack.archetype.name,
    context.repName,
    ...context.productNames,
    input.facts.product,
  ].filter((value) => value.trim() !== "");
}

/** The words the input already carries, which a body may always use. */
function allowedWords(input: OutreachInput, context: GateContext): Set<string> {
  return new Set(allowedValues(input, context).flatMap((value) => words(value)));
}

/** Everything the draft may cite: lookup items, the pack slice, the facts and the role's needs. */
function evidenceText(input: OutreachInput): string {
  return evidenceRaw(input).toLowerCase();
}

function evidenceRaw(input: OutreachInput): string {
  const pack = input.pack;
  return [
    ...input.lookup.items.flatMap((item) => [item.text, item.quote ?? ""]),
    pack.archetype.situation,
    ...pack.archetype.pains.flatMap((pain) => [pain.text, pain.quote ?? ""]),
    ...pack.archetype.language.map((phrase) => phrase.text),
    pack.hook?.text ?? "",
    pack.hook?.whyNow.text ?? "",
    ...pack.angles.map((angle) => angle.text),
    ...pack.doDont.flatMap((line) => [line.use, line.avoid]),
    ...pack.verbatim.flatMap((item) => [item.text, item.quote ?? ""]),
    // The approved quotes and who said them: "the FCA" is sourced when the evidence list names it.
    ...pack.evidence.flatMap((item) => [item.quote, item.sourceName]),
    ...pack.proof.map((proof) => proof.text),
    ...input.facts.facts.map((fact) => fact.text),
    input.buyerRole?.needs ?? "",
    input.account.seedEvidence ?? "",
  ].join("\n");
}

/** Runs of capitalised or numeric tokens that are not merely a sentence's first word. */
export function namedEntities(body: string): string[] {
  const found: string[] = [];
  for (const sentence of sentences(body)) {
    const tokens = sentence.split(/\s+/).map((token) => token.replace(/^[("'“‘]+|[)"'”’.,;:?!]+$/g, ""));
    let run: { text: string; index: number }[] = [];
    const flush = () => {
      // A lone capitalised word at the start of a sentence is a sentence start, unless it is an acronym or carries a digit.
      const onlyStart = run.length === 1 && run[0]!.index === 0 && !/^[A-Z0-9]{2,}$/.test(run[0]!.text) && !/\d/.test(run[0]!.text) && !/[a-z][A-Z]/.test(run[0]!.text);
      if (run.length > 0 && !onlyStart) found.push(run.map((t) => t.text).join(" "));
      run = [];
    };
    tokens.forEach((token, index) => {
      if (/^[A-Z][\w&'’.-]*$/.test(token) || /^[A-Z]{2,}s?$/.test(token)) run.push({ text: token, index });
      else flush();
    });
    flush();
  }
  return found;
}

/** Words that commonly open an English sentence. Never a name, whatever their case. */
const STARTERS = new Set(
  "so also just still yet even only then now instead otherwise however meanwhile again perhaps maybe happy glad worth given since because after before once until unless although though whether either neither both few several last next first second finally often usually sometimes typically currently recently today honestly curious fair sounds seems looks feel reading looking seeing having being going teams people firms handlers managers leaders directors most many some none nothing everything something anything".split(
    " ",
  ),
);

/**
 * A lone capitalised word that opens a sentence, when it is not ordinary
 * English. Ordinary means: a common opener, or a word the draft, the plan or
 * the facts also write in lower case. "Complaints rose" is a sentence; "Aviva
 * found" names a firm.
 */
function sentenceStartNames(body: string, lowerCorpus: string): string[] {
  const found: string[] = [];
  for (const sentence of sentences(body)) {
    const tokens = sentence.split(/\s+/).map((token) => token.replace(/^[("'“‘]+|[)"'”’.,;:?!]+$/g, ""));
    const [first, second] = tokens;
    if (first === undefined || !/^[A-Z][a-z][\w'’-]*$/.test(first)) continue;
    // A run of capitals is `namedEntities`' business.
    if (second !== undefined && /^[A-Z][\w&'’.-]*$/.test(second)) continue;
    const word = first.toLowerCase().replace(/['’]s$/, "");
    if (ORDINARY.has(word) || CALENDAR.has(word) || STARTERS.has(word)) continue;
    if (new RegExp(`(^|[^a-z0-9])${escape(word)}($|[^a-z0-9])`).test(lowerCorpus)) continue;
    found.push(first);
  }
  return found;
}

function provenanceFindings(body: string, input: OutreachInput, context: GateContext): { tierA: Finding[]; tierB: Finding[] } {
  const found: Finding[] = [];
  const advice: Finding[] = [];
  const allowed = allowedWords(input, context);
  const evidence = evidenceText(input);
  // Words written in lower case anywhere the draft could have learnt them: its own body and the evidence as written.
  const lowerCorpus = [body, evidenceRaw(input)].join("\n").match(/\b[a-z][a-z0-9'’-]*\b/g)?.join(" ") ?? "";

  const unsourced = (entity: string) => {
    const tokens = words(withoutChannels(entity)).filter((token) => !ORDINARY.has(token) && !CALENDAR.has(token) && !allowed.has(token));
    if (tokens.length === 0) return false;
    // Resolved when the remaining words appear together in the evidence.
    return !hasPhrase(evidence, tokens.join(" ")) && !tokens.every((token) => hasPhrase(evidence, token));
  };
  const unsourcedNames = namedEntities(body).filter(unsourced);
  if (unsourcedNames.length > 0) {
    found.push({ rule: "unsourced-name", text: `It names ${unsourcedNames.map((n) => `"${n}"`).join(", ")}, which is not in the lookup, the plan or the facts.` });
  }
  // A capitalised word that only opens a sentence is usually just a sentence ("Finding that pattern…"),
  // so it is advice for the rep to check rather than a hold. A name inside a sentence still holds.
  const startNames = sentenceStartNames(body, lowerCorpus).filter(unsourced);
  if (startNames.length > 0) {
    advice.push({ rule: "sentence-start-name", text: `A sentence opens with ${startNames.map((n) => `"${n}"`).join(", ")}; if that is a name, it is not in the lookup, the plan or the facts.` });
  }

  const allowedDigits = words([...allowed].join(" "));
  const numbers = (body.match(/\d[\d,.]*%?/g) ?? []).map((n) => n.replace(/[.,]$/, ""));
  const unsourcedNumbers = numbers.filter((n) => !evidence.includes(n.toLowerCase()) && !allowedDigits.includes(n.toLowerCase()));
  if (unsourcedNumbers.length > 0) {
    found.push({ rule: "unsourced-number", text: `The number ${unsourcedNumbers.join(", ")} traces to nothing in the lookup, the plan or the facts.` });
  }
  return { tierA: found, tierB: advice };
}

// ---------------------------------------------------------------------------
// Tier A: cohort template repetition (v2.1 §6, as corrected)
//
// Hard failures are meaningful template repetition only: a repeated opening
// frame, a reused ask, or a distinctive sentence that makes two emails read
// as one. Generic word overlap is advice, so the writer is never pushed into
// synonym-swapping to pass a gate.

function normalised(text: string, input: OutreachInput): string {
  let out = text.toLowerCase();
  for (const value of [input.person.name, input.person.firstName, input.person.company, input.account.company]) {
    if (value.trim() !== "") out = out.split(value.toLowerCase()).join(" ");
  }
  return words(out).join(" ");
}

function jaccard(a: string, b: string): number {
  const left = new Set(a.split(" ").filter(Boolean));
  const right = new Set(b.split(" ").filter(Boolean));
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const word of left) if (right.has(word)) shared += 1;
  return shared / (left.size + right.size - shared);
}

/** The first five words of the first sentence: the opening frame. */
function frame(body: string, input: OutreachInput): string {
  return normalised(sentences(body)[0] ?? "", input).split(" ").slice(0, 5).join(" ");
}

/** How many different people a set of drafts was written for (M2 fix 2): the cohort gates count people, not drafts. */
export function peopleIn(drafts: readonly Pick<CohortDraft, "personId">[]): number {
  return new Set(drafts.map((draft) => draft.personId)).size;
}

function cohortFindings(draft: MessageDraft, input: OutreachInput, cohort: readonly CohortDraft[]): { tierA: Finding[]; tierB: Finding[] } {
  const tierA: Finding[] = [];
  const tierB: Finding[] = [];
  if (cohort.length === 0) return { tierA, tierB };

  // Every rule reads "two or more people, or one colleague at the same account". A person is counted once
  // however many of their touches match: in the 23 Sep cohort one colleague's Email 2 and LinkedIn message
  // carrying the same quote counted as two, and that alone held another person's Email 1.

  // Opening frame: near-identical to two or more people's, or to a colleague's.
  const mine = frame(draft.body, input);
  const firstSentence = normalised(sentences(draft.body)[0] ?? "", input);
  const sameFrame = cohort.filter((other) => {
    const theirs = frame(other.body, input);
    return (mine !== "" && mine === theirs) || jaccard(firstSentence, normalised(sentences(other.body)[0] ?? "", input)) >= 0.7;
  });
  if (peopleIn(sameFrame) >= 2 || sameFrame.some((other) => other.sameAccount)) {
    tierA.push({ rule: "cohort-opening", text: "It opens the same way as other emails in this campaign; open on this person's own reason." });
  }

  // The ask: identical after normalising to two or more people's, or to a colleague's.
  const ask = normalised(draft.ask, input);
  const sameAsk = cohort.filter((other) => normalised(other.ask, input) === ask);
  if (peopleIn(sameAsk) >= 2 || sameAsk.some((other) => other.sameAccount)) {
    tierA.push({ rule: "cohort-ask", text: "The question at the end is the same as in other emails in this campaign; ask it this person's way." });
  }

  // A distinctive sentence near-identical to two or more people's, or to a colleague's.
  //
  // A sentence carrying an approved quote is exempt across firms (M2 fix 2): the quote is the same because
  // the source's words are the same, and readers at different firms never compare notes. Never at the same
  // account: colleagues must not be sent the same quote, and the 23 Sep cohort's one real repeat (Nell's
  // LinkedIn message, the FCA sentence her colleague Blair had in Email 1) is exactly that.
  const runs = quoteRuns(input.pack.evidence);
  const repeated = sentences(draft.body)
    .filter((sentence) => normalised(sentence, input).split(" ").length >= 7)
    .find((sentence) => {
      const mineNormalised = normalised(sentence, input);
      const quoted = quotesEvidence(sentence, runs);
      const hits = cohort.filter((other) => (!quoted || other.sameAccount) && sentences(other.body).some((theirs) => jaccard(mineNormalised, normalised(theirs, input)) >= 0.8));
      return peopleIn(hits) >= 2 || hits.some((other) => other.sameAccount);
    });
  if (repeated !== undefined) {
    tierA.push({ rule: "cohort-sentence", text: "A sentence repeats one from other emails in this campaign almost word for word." });
  }

  // Generic overlap: advice only.
  const grams = (text: string) => {
    const list = normalised(text, input).split(" ");
    return new Set(list.slice(0, Math.max(0, list.length - 3)).map((_, i) => list.slice(i, i + 4).join(" ")));
  };
  const own = grams(draft.body);
  const heaviest = Math.max(0, ...cohort.map((other) => {
    const theirs = grams(other.body);
    let shared = 0;
    for (const gram of own) if (theirs.has(gram)) shared += 1;
    return own.size === 0 ? 0 : shared / own.size;
  }));
  if (heaviest > 0.25) tierB.push({ rule: "cohort-overlap", text: "Much of the wording is shared with another email in this campaign." });
  return { tierA, tierB };
}

// ---------------------------------------------------------------------------
// Tier A: evidence quoted word for word (M2, 23 Sep 2026)
//
// The 22 Sep re-review's headline: 7 of 14 attributed gives misstated their
// source. Three said the FCA's tables show "the share upheld by the
// ombudsman" (the column is upheld by the *firm*); three hardened "not as
// effective as they might need to be" into "weren't working"; one invented
// "almost always" and put it on the ombudsman's quarterly data. None of them
// is a lie a prompt line can catch, because each is a plausible paraphrase of
// something the drafter was actually given.
//
// So the rule is not "be accurate", it is "use the source's own words". A
// sentence that attributes something to a regulator, an ombudsman or a
// publication must carry a run of the evidence list's stored wording, or it
// says nothing about them at all.

/** A third party named outright: a regulator, an ombudsman, a watchdog. Always a source claim. */
const SOURCE_NAMED_OUTRIGHT = /\b(?:fca|financial conduct authority|fos|ombudsman|regulator|regulators|regulatory body|consumer duty|which\?)\b/i;

/**
 * The words that only sometimes mean a source: "publishes", "publication",
 * "figures show". They carry a source claim in "the FCA publishes each firm's
 * figures" and carry none at all in "your July complaints publication
 * mentioned delay", which is the reader's own firm and the lookup's business.
 */
const PUBLISH = /\bpublish(?:es|ed|ing)?\b|\bpublication\b/i;
const FIGURES_SHOW = /\bfigures show\b/i;

/**
 * Something said to be published *about* someone, or to sit in a table: "published against Ardent's name",
 * "the public tables". Not "published on", which is as often a date or a place ("published on your site"). That is a claim about what a third party publishes,
 * whoever is named, and the 23 Sep cohort sent it five times with nothing behind it (M2 fix 2).
 */
const PUBLISHED_ABOUT = /\bpublished (?:against|about)\b|\b(?:public|league|sortable) tables?\b/i;

/** A sentence written to the reader about themselves. */
const SECOND_PERSON = /^\s*(?:you|your)\b/i;

/**
 * A sentence reporting what someone found, said or measured.
 *
 * Verbs and attributions only. The nouns ("review", "research", "data",
 * "figures") were here first and cost the standard's own call exemplar a
 * hold: "a one-off £640 configuration review around month one" is a price,
 * not a finding, and `review` matched it. Where those nouns do carry a source
 * claim, the source itself is named and `SOURCE_NAMED_OUTRIGHT` has it already.
 */
const REPORTED =
  /\b(?:found|finds|show|shows|showed|shown|said|says|reported|reports|rose|risen|fell|fallen|up from|down from|according to|reviewed|surveyed)\b/i;

const FIGURE = /\d[\d,.]*\s?%|\d[\d,]*/;

/** A text with the given names taken out, so "Insights360" is a product and not the figure 360 (M2 fix 2). */
function withoutNames(text: string, names: readonly string[]): string {
  let out = text;
  for (const name of [...names].sort((a, b) => b.length - a.length)) {
    if (name.trim() === "") continue;
    out = out.replace(new RegExp(`(^|[^a-z0-9])${escape(name.trim())}(?=$|[^a-z0-9])`, "gi"), "$1 ");
  }
  return out;
}

/**
 * True when a sentence makes a claim about a source.
 *
 * A named regulator is always a source claim. "Publish" or "publication" is one only when it comes with a
 * figure or says something is published about someone or sits in a table (M2 fix 2): "after a complaints
 * publication" and "we already publish our figures" are the reader's own business, and holding them cost
 * four false holds in the 23 Sep cohort. A bare number is one only when the sentence also reports
 * something — otherwise the gate would hold the call script's complete price answer ("a one-off setup fee
 * of £1,280"). `names` are the words the input already carries (the product, the firm, the person): never
 * read as a figure, so "Insights360… so a theme can be shown" is not a report of the number 360.
 */
export function attributesASource(sentence: string, names: readonly string[] = []): boolean {
  if (SOURCE_NAMED_OUTRIGHT.test(sentence) || FIGURES_SHOW.test(sentence)) return true;
  const figure = FIGURE.test(withoutNames(sentence, names));
  if (PUBLISHED_ABOUT.test(sentence) || (PUBLISH.test(sentence) && figure)) return true;
  return figure && REPORTED.test(sentence);
}

/** The words of a text for quote matching: lower case, apostrophes folded, punctuation dropped. */
function quoteWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[^a-z0-9£%'\s]/g, " ")
    .split(/\s+/)
    .filter((word) => word !== "");
}

/** How many consecutive words of a source's own wording a sentence must carry. */
export const QUOTE_RUN_WORDS = 6;

/** Every run of `QUOTE_RUN_WORDS` words in the evidence list, normalised. */
export function quoteRuns(evidence: readonly EvidenceQuote[], run: number = QUOTE_RUN_WORDS): Set<string> {
  const runs = new Set<string>();
  for (const item of evidence) {
    const list = quoteWords(item.quote);
    for (let i = 0; i + run <= list.length; i += 1) runs.add(list.slice(i, i + run).join(" "));
  }
  return runs;
}

/** True when a sentence carries a run of the evidence list's own wording. */
export function quotesEvidence(sentence: string, runs: ReadonlySet<string>, run: number = QUOTE_RUN_WORDS): boolean {
  const list = quoteWords(sentence);
  for (let i = 0; i + run <= list.length; i += 1) {
    if (runs.has(list.slice(i, i + run).join(" "))) return true;
  }
  return false;
}

/** The bodies a sentence can credit by name, and the words that name each. */
const SOURCE_FAMILIES: readonly (readonly [string, RegExp])[] = [
  // "The regulator" and the Consumer Duty are the FCA's, for a UK insurer: the ombudsman's figures credited to
  // "the regulator" are the same mix-up as crediting them to the FCA.
  ["fca", /\b(?:fca|financial conduct authority|regulators?|regulatory body|consumer duty)\b/i],
  ["ombudsman", /\b(?:ombudsman|fos)\b/i],
];

function familiesIn(text: string): Set<string> {
  return new Set(SOURCE_FAMILIES.filter(([, pattern]) => pattern.test(text)).map(([family]) => family));
}

/**
 * The body a quote is from, read off its `sourceName`, and only when that is a written name. The adapter
 * writes a name only for a host it knows (fca.org.uk is "the FCA") or a give a person approved; any other
 * source is named by its bare host, which is never read as a body, so "fca-news.example" is not the FCA.
 */
function familiesOfQuote(quote: EvidenceQuote): Set<string> {
  return /\s/.test(quote.sourceName.trim()) ? familiesIn(quote.sourceName) : new Set();
}

/**
 * Words that make a claim more general than a source said it (M2 fix 2): "mostly on valuation, cancellation
 * and delay". "Most recent" is a date, not a frequency.
 */
const FREQUENCY_WORDS: readonly (readonly [string, RegExp])[] = [
  ["mostly", /\bmostly\b/i],
  ["most", /\bmost\b(?!\s+recent)/i],
  ["usually", /\busually\b/i],
  ["always", /\balways\b/i],
];

/**
 * Every sentence that attributes something to a source without quoting that source (M2, as fix round 2
 * tightened it). A sentence passes only on its own words: it carries a run of a quote from the body it
 * names, and adds no frequency word that quote lacks.
 *
 * The finding names the sentence, because the rep reads this on the card and
 * "an unsupported source claim" tells them nothing about which one to look at.
 *
 * `about` is the reader's firm and name, as whole phrases. `names` are the words the input carries, which
 * are never read as a figure.
 */
export function unsupportedSourceClaims(parts: readonly string[], evidence: readonly EvidenceQuote[], about: readonly string[] = [], names: readonly string[] = []): string[] {
  const quotes = evidence.map((quote) => ({ quote, runs: quoteRuns([quote]), families: familiesOfQuote(quote) }));
  const held: string[] = [];
  for (const part of parts) {
    for (const sentence of sentences(part)) {
      if (!attributesASource(sentence, names)) continue;
      // A question asserts nothing. "Would it help if I sent over the FCA's
      // write-up?" offers a document; it does not say what the FCA found.
      if (sentence.trim().endsWith("?")) continue;
      // A sentence about the reader's own firm, or to the reader, is personalisation, and the provenance gates
      // hold it against the lookup. Never when a regulator is named or the sentence says something is published
      // about someone: that is a third party's finding whoever it is about. The firm is matched as a whole
      // phrase, never a word of it — "motor" or "insurance" from Ardent Motor Insurance, or a prospect called
      // Will, let "The FCA will name firms…" through in fix round 1.
      const thirdParty = SOURCE_NAMED_OUTRIGHT.test(sentence) || PUBLISHED_ABOUT.test(sentence);
      if (!thirdParty && (about.some((phrase) => phrase.trim() !== "" && hasPhrase(sentence, phrase.trim())) || SECOND_PERSON.test(sentence))) continue;
      // The quote must be in this sentence: a quote beside it clears nothing (fix round 1's neighbour window
      // passed "Those figures get published against Ardent's name" after the ombudsman's sentence). And it must
      // be from the body the sentence credits: six words of any quote is not the FCA's word.
      const named = familiesIn(sentence);
      const matched = quotes.filter(({ runs, families }) => quotesEvidence(sentence, runs) && (named.size === 0 || [...named].some((family) => families.has(family))));
      const widened = FREQUENCY_WORDS.some(([, pattern]) => pattern.test(sentence) && !matched.some(({ quote }) => pattern.test(quote.quote)));
      if ((matched.length === 0 || widened) && !held.includes(sentence)) held.push(sentence);
    }
  }
  return held;
}

/** Which evidence quotes a text actually carries, by id: what a colleague at the same firm has already used. */
export function evidenceUsedIn(text: string, evidence: readonly EvidenceQuote[]): string[] {
  return evidence.filter((quote) => presentRuns(text, quoteRuns([quote])).size > 0).map((quote) => quote.id);
}

/** Words too common to say which quote a sentence was reaching for. */
const QUOTE_STOP = new Set(
  "the a an and or of to in on for by with at as is are was were be been it its it's this that these those their they them from not but have has had can could would should will may might more most some any each every all no firms firm".split(" "),
);

/**
 * The approved quote a held sentence was paraphrasing: the evidence item sharing the most distinctive words
 * with it, its source's name included, when it shares at least three. Null when nothing is close, and then the fix is to drop the source.
 */
export function closestQuote(sentence: string, evidence: readonly EvidenceQuote[]): EvidenceQuote | null {
  const distinct = (text: string) => quoteWords(text).map((word) => word.replace(/'s$/, "")).filter((word) => !QUOTE_STOP.has(word));
  const mine = new Set(distinct(sentence));
  let best: { quote: EvidenceQuote; shared: number } | null = null;
  for (const quote of evidence) {
    // Who said it counts as much as what was said: a paraphrase keeps the attribution ("the FCA's review of
    // 40 firms") and loses the wording, which is the whole fault.
    const shared = new Set(distinct(`${quote.sourceName} ${quote.quote}`).filter((word) => mine.has(word))).size;
    if (shared >= 3 && (best === null || shared > best.shared)) best = { quote, shared };
  }
  return best?.quote ?? null;
}

const clip = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max - 1)}…`);

/**
 * One finding per held sentence, each saying exactly what to do (M2 fix 1): the approved quote to use word for
 * word, or remove the source reference. "Use an approved quote exactly, or leave the point out" left the
 * corrective call to guess which quote, and it guessed a paraphrase again.
 */
function evidenceFindings(parts: readonly string[], input: OutreachInput, context: GateContext): Finding[] {
  const held = unsupportedSourceClaims(parts, input.pack.evidence, [input.person.company, input.account.company, input.person.name], allowedValues(input, context));
  return held.map((sentence) => ({ rule: "unsupported-source-claim", text: sourceClaimFix(sentence, closestQuote(sentence, input.pack.evidence)) }));
}

/**
 * The longest a finding may be and still reach the corrective call whole: the redraft carries each at most
 * 500 characters, with the touch's name in front. A quote cut short is not a quote, so a long one is named by
 * its id in the evidence list instead of being clipped.
 */
export const SOURCE_FIX_MAX_CHARS = 470;

export function sourceClaimFix(sentence: string, quote: EvidenceQuote | null): string {
  const said = `"${clip(sentence, 90)}" puts a source's finding in its own words.`;
  if (quote === null) return `${said} No approved quote says this: remove the source reference and make the point in plain words.`;
  const whole = `${said} Use this approved quote exactly: "${quote.quote}" (${quote.sourceName}). Or remove the source reference.`;
  return whole.length <= SOURCE_FIX_MAX_CHARS ? whole : `${said} Use approved quote ${quote.id} from the evidence list exactly, word for word. Or remove the source reference.`;
}

// ---------------------------------------------------------------------------
// Tier A: the standard's rules, as gates rather than counts (M2, item 2)
//
// M1 measured these and every one of them was clean at n = 6. They were clean
// because the model complied, not because anything stopped it, and
// `messageChecks.ts` said so in as many words. Six clean sequences are not
// evidence about twenty, so the reliable ones are gates here. The measures
// stay where they are: the report still counts, and now the gate holds.

/** The touches a prospect reads cold: the price rule and the product rule are about these. */
const COLD: readonly string[] = ["email1", "email2", "breakup", "li_connect", "li_dm", "li_dm2"];

/** A touch as `messageChecks` reads it. */
function checkedOf(draft: OutreachOutput, kind: string): Parameters<typeof namesProduct>[0] {
  const subject = draft.kind === "message" ? draft.subject : undefined;
  return {
    kind,
    ...(subject === undefined ? {} : { subject }),
    body: draft.kind === "message" ? draft.body : proseText(draft),
    ask: draft.kind === "message" ? draft.ask : draft.talkingPoint.oneQuestion,
    claims: [...draft.claims],
  };
}

/** The last sentence of an earlier touch: its ask, as the thread carries it. */
export function askOfThreadEntry(entry: { body: string }): string {
  return sentences(entry.body).at(-1) ?? "";
}

/**
 * An ask's shape: the first two words of the question itself.
 *
 * Two words, not three. The fault the 22 Sep cohort showed is a slot
 * template — "Who owns…" ended all six Email 2s and "Would it help if I sent
 * over…" appeared for five of six people — and at three words "Who owns this"
 * and "Who owns the" read as different shapes when a reader would call them
 * the same question.
 *
 * A leading clause is dropped first. "When a delay complaint lands, how do
 * you find the calls behind it?" is a "how do you" question; taking its
 * literal first two words gives "when a", which is a subordinate clause and
 * says nothing about the shape of what is being asked.
 */
export function askShapeOf(ask: string): string {
  const question = ask.includes(",") ? ask.slice(ask.lastIndexOf(",") + 1) : ask;
  return quoteWords(question).slice(0, 2).join(" ");
}

function standardFindings(draft: OutreachOutput, input: OutreachInput, context: GateContext): { tierA: Finding[]; tierB: Finding[] } {
  const tierA: Finding[] = [];
  const tierB: Finding[] = [];
  const kind = input.touch.kind;
  const checked = checkedOf(draft, kind);
  const cold = COLD.includes(kind);

  // No pitch in Email 1. The prompt has said so since M1; this is what makes it true.
  if (kind === "email1" && namesProduct(checked, input.facts.product)) {
    tierA.push({ rule: "product-in-email1", text: "A first email says nothing about the product: no name, no description of what it does, and no cited fact." });
  }
  // No price in anything the prospect reads cold. Price belongs in the call's answer to a price question.
  if (cold && mentionsPrice(checked)) {
    tierA.push({ rule: "price-in-message", text: "This carries a price, a fee or a contract term. Price belongs only in the call, as the answer to a price question." });
  }
  // No gender guesses, anywhere, including the call notes.
  const pronouns = [...new Set(genderedPronouns({ ...checked, body: proseText(draft) }))];
  if (pronouns.length > 0) {
    tierA.push({ rule: "gendered-pronoun", text: `It says ${pronouns.map((word) => `"${word}"`).join(", ")} about the prospect. Use their name or "they".` });
  }

  // At most one "X, or Y?" question in the whole sequence: this one, against the touches already written.
  if (isBinaryAsk(checked.ask) && input.thread.some((entry) => isBinaryAsk(askOfThreadEntry(entry)))) {
    tierA.push({ rule: "binary-ask", text: 'An earlier touch already ends on an "X, or Y?" question; a sequence carries at most one. Ask this one openly.' });
  }

  // The ask changes shape across the sequence, rather than filling the same slot in every touch.
  //
  // The call is out of this. Its one question deliberately reprises the email
  // the rep is ringing about — the standard's own call exemplar asks Email 1's
  // question almost word for word, which is how a rep opens a call about an
  // email, not a template.
  const shape = kind === "call" ? "" : askShapeOf(checked.ask);
  if (shape !== "" && input.thread.some((entry) => entry.kind !== "call" && askShapeOf(askOfThreadEntry(entry)) === shape)) {
    tierA.push({ rule: "ask-shape", text: `An earlier touch already asks a "${shape}…" question. Ask this one a different way.` });
  }
  // The same shape across the campaign is a template a rep sees when they approve twenty in a row,
  // but it is not this draft's fault and it must never push the writer into synonym-swapping: advice.
  if (shape !== "" && peopleIn(context.cohort.filter((other) => askShapeOf(other.ask) === shape)) > 3) {
    tierB.push({ rule: "cohort-ask-shape", text: `More than three people in this campaign are being asked a "${shape}…" question.` });
  }

  // The facts file's never-say list. Research has been linted against it since brief E; outreach
  // writes to the same prospects about the same product and was not, which is the gap M2 closes.
  if (context.neverSay !== undefined) {
    const issues = neverSayIssues(proseParts(draft).map((text, index) => ({ where: `part ${index + 1}`, text })), context.neverSay);
    if (issues.length > 0) {
      tierA.push({ rule: "never-say", text: `It says something the product's own facts forbid: ${issues.map((issue) => issue.replace(/^part \d+: /, "")).join("; ")}` });
    }
  }
  return { tierA, tierB };
}

// ---------------------------------------------------------------------------
// Tier B: advice on the card

const HEDGES = /\b(?:perhaps|maybe|might|probably|i suspect|i imagine|i think|i guess|i wonder|possibly)\b/gi;

function adviceFindings(draft: MessageDraft): Finding[] {
  const found: Finding[] = [];
  const subject = draft.subject?.trim() ?? "";
  const subjectWords = subject === "" ? 0 : subject.split(/\s+/).length;
  if (subject === "") found.push({ rule: "subject", text: "There is no subject line." });
  else if (subjectWords < 2 || subjectWords > 6 || subject.length > 45) found.push({ rule: "subject", text: "Subjects work best at 2 to 6 plain words." });
  else if (/quick question/i.test(subject)) found.push({ rule: "subject", text: "\"Quick question\" reads as a template." });

  const list = sentences(draft.body);
  const average = list.length === 0 ? 0 : words(draft.body).length / list.length;
  if (average > 22) found.push({ rule: "reading", text: "The sentences are long for a phone; shorter ones read faster." });
  // Three short items in a row ("faster, cheaper and simpler"); a clause before ", and" is not a list.
  if (/\b[\w'-]+(?: [\w'-]+){0,2}, [\w'-]+(?: [\w'-]+){0,2},? and [\w'-]+(?: [\w'-]+){0,2}[.?!,]/i.test(draft.body)) found.push({ rule: "three", text: "A list of three can read as a pattern; one or two is usually enough." });
  if ((draft.body.match(HEDGES) ?? []).length > 2) found.push({ rule: "hedges", text: "Several hedges in a row soften the point too much." });
  const lengths = list.map((s) => words(s).length);
  if (lengths.length >= 4 && Math.max(...lengths) - Math.min(...lengths) <= 3) found.push({ rule: "rhythm", text: "Every sentence is about the same length; vary one." });
  return found;
}

// ---------------------------------------------------------------------------

/** Every gate on a first email: v2's `checkTouchLimits` and v2.1's additions. */
export function gateEmail1(draft: OutreachOutput, input: OutreachInput, context: GateContext): GateResult {
  if (draft.kind !== "message") return { tierA: [{ rule: "kind", text: "A first email is a message, not a call." }], tierB: [] };
  const cohort = cohortFindings(draft, input, context.cohort);
  const provenance = provenanceFindings(draft.body, input, context);
  const standard = standardFindings(draft, input, context);
  const tierA = [
    ...checkTouchLimits(draft, input),
    ...shapeFindings(draft, input, input.standard.bannedLexicon),
    ...provenance.tierA,
    ...evidenceFindings([draft.subject ?? "", draft.body], input, context),
    ...standard.tierA,
    ...cohort.tierA,
  ];
  return { tierA, tierB: [...adviceFindings(draft), ...provenance.tierB, ...standard.tierB, ...cohort.tierB] };
}

/**
 * `claims` is for the product statements in the body. The model sometimes
 * lists its opener there too (the 15 Sep cohort: four of five holds), which is
 * a harmless label and not a claim. Before the gates, any id that is not a
 * product fact and is the opener's ref, a lookup item or a plan item is moved
 * out. An id that resolves to nothing stays, and `claim-id` still holds it.
 */
export function normaliseClaims<T extends OutreachOutput>(draft: T, input: OutreachInput): T {
  const facts = new Set(input.facts.facts.map((fact) => fact.id));
  const pack = input.pack;
  const notClaims = new Set([
    draft.opener.ref,
    ...input.lookup.items.map((item) => item.id),
    ...pack.archetype.pains.map((pain) => pain.id),
    ...pack.archetype.language.map((phrase) => phrase.id),
    ...(pack.hook === undefined ? [] : [pack.hook.id]),
    ...pack.angles.map((angle) => angle.id),
    ...pack.verbatim.map((item) => item.id),
    ...(input.buyerRole === undefined ? [] : [input.buyerRole.id]),
  ]);
  const claims = draft.claims.filter((claim) => facts.has(claim) || !notClaims.has(claim));
  return claims.length === draft.claims.length ? draft : { ...draft, claims };
}

// ---------------------------------------------------------------------------
// The rest of the sequence (P2, 21 Sep 2026)

/**
 * The words a rep reads on a touch, part by part: a message's subject and
 * body, or a call script's lines. Kept apart because a subject or a line
 * without a full stop would otherwise run into the next part as one sentence,
 * and a sentence's first word would read as a name in the middle of one.
 */
export function proseParts(draft: OutreachOutput): string[] {
  if (draft.kind === "message") return [draft.subject ?? "", draft.body].filter((part) => part !== "");
  const point = draft.talkingPoint;
  return [point.openingLine, point.oneQuestion, point.openingLine2 ?? "", point.oneQuestion2 ?? "", point.listenFor, point.voicemail ?? "", ...(point.objections ?? []).flatMap((pair) => [pair.objection, pair.answer])].filter(
    (part) => part !== "",
  );
}

/** The same, as one text, for the checks that read words rather than sentences. */
export function proseText(draft: OutreachOutput): string {
  return proseParts(draft).join("\n");
}

/**
 * Every gate on a touch other than the first email: its own limits
 * (`checkTouchLimits`, which reads the touch's own row), the tell list, the
 * wording rules, and provenance. No cohort logic: a follow-up is read against
 * this person's own earlier touches, which the writer is given.
 */
export function gateTouch(draft: OutreachOutput, input: OutreachInput, context: GateContext): GateResult {
  const kind = input.touch.kind;
  if (kind === "email1") return gateEmail1(draft, input, context);
  if ((draft.kind === "call") !== (kind === "call")) {
    return { tierA: [{ rule: "kind", text: kind === "call" ? "A call script is a talking point, not a message." : "This touch is a message, not a call script." }], tierB: [] };
  }
  const text = proseText(draft);
  const found: Finding[] = [...checkTouchLimits(draft, input)];
  if (text.includes("!")) found.push({ rule: "exclamation", text: "No exclamation marks." });
  if (draft.kind === "message") {
    if ((kind === "email2" || kind === "breakup") && /https?:\/\/|www\.[a-z]/i.test(draft.body)) found.push({ rule: "link", text: "A follow-up email carries no link." });
    if (TIME_ASK.some((pattern) => pattern.test(`${draft.ask} ${draft.body}`))) {
      found.push({ rule: "time-ask", text: "It asks for a time, a meeting length or a calendar slot; ask whether it is relevant instead." });
    }
    const first = input.person.firstName.trim();
    const opensWithName = first !== "" && new RegExp(`^\\s*${escape(first)}\\s*[,!.]`, "i").test(draft.body);
    const signsOff = /\n\s*(?:best|thanks|many thanks|cheers|regards|kind regards|best wishes)[,.!]?\s*(?:\n.*)?$/i.test(draft.body);
    // M2: a connection note is the one touch Relay puts no envelope around —
    // LinkedIn sends it as written — so "Hi Avery," there is the note's own
    // first words, not a greeting Relay would have added twice. The sign-off
    // rule still holds: LinkedIn shows who is connecting.
    const greeted = /^\s*(?:hi|hello|hey|dear|morning|good morning|afternoon)\b/i.test(draft.body) || opensWithName;
    if ((greeted && kind !== "li_connect") || signsOff) {
      found.push({ rule: "envelope", text: "The greeting and the sign-off are added for you; the message starts with the first sentence and ends with the question." });
    }
  } else {
    if (draft.talkingPoint.voicemail === undefined) found.push({ rule: "voicemail", text: "The call script has no voicemail." });
    // M2: the rep rings twice. One script read out twice is the same call twice.
    if (draft.talkingPoint.openingLine2 === undefined || draft.talkingPoint.oneQuestion2 === undefined) {
      found.push({ rule: "second-call", text: "The script has nothing for the second call: it needs its own opener and its own question." });
    }
  }
  if (ANTITHESIS.some((pattern) => pattern.test(text))) found.push({ rule: "antithesis", text: "It uses the \"it isn't X, it's Y\" turn; say the point plainly." });
  const tells = input.standard.bannedLexicon.filter((phrase) => hasTell(text, phrase));
  if (tells.length > 0) found.push({ rule: "tells", text: `It uses ${tells.map((t) => `"${t}"`).join(", ")}, which reads as a template.` });
  const us = US_SPELLINGS.filter((word) => new RegExp(`\\b${word}\\b`, "i").test(text));
  if (us.length > 0) found.push({ rule: "spelling", text: `American spelling: ${us.join(", ")}. Use British English.` });
  // Provenance part by part, one finding per rule and text.
  const checked = proseParts(draft).map((part) => provenanceFindings(part, input, context));
  const unique = (list: Finding[]) => list.filter((finding, index) => list.findIndex((other) => other.rule === finding.rule && other.text === finding.text) === index);
  const provenance = { tierA: unique(checked.flatMap((result) => result.tierA)), tierB: unique(checked.flatMap((result) => result.tierB)) };
  const advice = draft.kind === "message" ? adviceFindings(draft).filter((finding) => finding.rule !== "subject") : [];
  const standard = standardFindings(draft, input, context);
  // M2: colleagues at the same firm, on every touch rather than Email 1 alone.
  //
  // The 22 Sep cohort put the same product sentence in two colleagues' Email
  // 2s at Ardent and the same FCA give and the same offer in their LinkedIn
  // touches, because `cohortFindings` only ever ran on Email 1. It runs on
  // every touch now, against the same account only: a later touch is read
  // against this person's own thread, and repeating a stranger's Email 2 in a
  // LinkedIn message is not the same fault as repeating a colleague's.
  const sameAccount = context.cohort.filter((other) => other.sameAccount);
  const cohort = draft.kind === "message" && sameAccount.length > 0 ? cohortFindings(draft, input, sameAccount) : { tierA: [], tierB: [] };
  return {
    tierA: [...found, ...provenance.tierA, ...evidenceFindings(proseParts(draft), input, context), ...standard.tierA, ...cohort.tierA],
    tierB: [...advice, ...provenance.tierB, ...standard.tierB, ...cohort.tierB],
  };
}

/**
 * A touch without a subject it will never be sent with (M2 fix 1). Only Email 1 opens a thread: the follow-up
 * and the last email are replies in it, and LinkedIn and a call have no subject line. A subject the model
 * wrote for one of those anyway is dropped here, before the gates, rather than holding the touch for words the
 * rep never sees; in the 23 Sep cohort that held Emlyn's last email, and a discarded LinkedIn subject was the
 * only sentence behind the hold on one of her LinkedIn messages.
 */
export function withoutThreadSubject<T extends OutreachOutput>(draft: T, kind: string): T {
  if (kind === "email1" || draft.kind !== "message" || draft.subject === undefined) return draft;
  const rest: MessageDraft = { ...draft };
  delete rest.subject;
  return rest as T;
}

/** The gate for a touch, chosen by its kind: Email 1 keeps its own. */
export function gateFor(draft: OutreachOutput, input: OutreachInput, context: GateContext): GateResult {
  return input.touch.kind === "email1" ? gateEmail1(draft, input, context) : gateTouch(draft, input, context);
}

/**
 * What a humanized touch lost, or null when it lost nothing (M2, item 3).
 *
 * The humanizer is subtractive by design, and `addedFacts` already refuses
 * anything it *added*. The 22 Sep cohort showed the other half of the risk:
 * it cut the give out of Marlo's Email 2 (45% of the words), leaving "a
 * pattern like that" pointing at nothing, and it reworded an attributed
 * sentence in Emlyn's ("kept some that weren't" became "kept ones that
 * weren't working"). Both passed every gate, because nothing checked that
 * the point survived.
 *
 * Three things must survive a pass: the question, the source's own wording,
 * and most of the words. A touch that loses any of them keeps its drafted
 * version — the drafted words are always a safe fallback, so rejecting is
 * cheap and keeping a broken rewrite is not.
 */
export const HUMANIZER_MAX_WORD_LOSS = 0.4;

export function humanizerLoss(
  before: OutreachOutput,
  after: OutreachOutput,
  evidence: readonly EvidenceQuote[],
  /**
   * True when the shrinkage is a verified clean cut of the product sentence
   * (`isCleanCut`). Messaging v2 lets the pass drop the pitch, and on a short
   * touch that one sentence is easily half the words, so the word count is
   * not evidence of anything there. The question and the quotes still have to
   * survive.
   */
  cleanProductCut = false,
): string | null {
  const ask = after.kind === "message" ? after.ask : after.talkingPoint.oneQuestion;
  if (ask.trim() === "") return "it left the touch with no question";

  // Every run of a source's own wording the draft carried must still be there, word for word, unless the
  // whole sentence carrying it was cut cleanly (M2 fix 2).
  const runs = quoteRuns(evidence);
  const had = presentRuns(proseText(before), runs);
  const kept = presentRuns(proseText(after), runs);
  const lost = [...had].filter((run) => !kept.has(run));
  if (lost.length > 0 && !quoteSentencesCut(before, after, runs)) return `it reworded an approved quote ("${lost[0]!}")`;

  if (cleanProductCut) return null;
  // A clean quote cut still counts against the word loss: cutting the give and leaving "a pattern like that"
  // pointing at nothing (Marlo's Email 2, 22 Sep) is still losing the point.
  const wasWords = words(proseText(before)).length;
  const nowWords = words(proseText(after)).length;
  if (wasWords > 0 && nowWords < wasWords * (1 - HUMANIZER_MAX_WORD_LOSS)) {
    return `it cut ${Math.round(((wasWords - nowWords) / wasWords) * 100)}% of the words, which loses the point rather than tightening it`;
  }
  return null;
}

/**
 * True when every quote the pass lost went with its whole sentence, false when a quote was reworded instead.
 *
 * The humanizer may drop a whole attributed sentence, as it may drop the product sentence: in the 23 Sep
 * cohort it cut Marlo's Gormley line and Nell's "the FCA publishes" line, and the guard kept the worse
 * drafts because it read the cut as rewording. A cut is clean when (1) no run of the cut sentence's quote
 * survives anywhere, so it was not trimmed or had a word slipped in ("recorded", "regulated firms"), and
 * (2) no new sentence in the pass reads closest to the cut one, so it was not paraphrased in other words.
 */
function quoteSentencesCut(before: OutreachOutput, after: OutreachOutput, runs: ReadonlySet<string>): boolean {
  const kept = presentRuns(proseText(after), runs);
  const drafted = proseParts(before).flatMap((part) => sentences(part));
  const rewritten = proseParts(after).flatMap((part) => sentences(part));
  const gone = drafted.filter((sentence) => {
    const carried = presentRuns(sentence, runs);
    return carried.size > 0 && [...carried].some((run) => !kept.has(run));
  });
  // Part of the sentence's quote is still there: trimmed or reworded, not cut.
  if (gone.some((sentence) => [...presentRuns(sentence, runs)].some((run) => kept.has(run)))) return false;
  const bag = (text: string) => words(text).join(" ");
  const unchanged = new Set(drafted.map(bag));
  for (const sentence of rewritten) {
    const mine = bag(sentence);
    if (unchanged.has(mine)) continue;
    let closest: { sentence: string; score: number } | null = null;
    for (const candidate of drafted) {
      const score = jaccard(mine, bag(candidate));
      if (closest === null || score > closest.score) closest = { sentence: candidate, score };
    }
    if (closest !== null && closest.score >= 0.2 && gone.includes(closest.sentence)) return false;
  }
  return true;
}

/** The evidence runs a text actually carries. */
function presentRuns(text: string, runs: ReadonlySet<string>): Set<string> {
  const list = quoteWords(text);
  const found = new Set<string>();
  for (let i = 0; i + QUOTE_RUN_WORDS <= list.length; i += 1) {
    const run = list.slice(i, i + QUOTE_RUN_WORDS).join(" ");
    if (runs.has(run)) found.add(run);
  }
  return found;
}

/**
 * What a rewrite added that the draft did not have: a number, or a name. The
 * humanizer is subtractive (facts locked, voice free), so anything here sends
 * the touch back to its drafted words. A name counts as added when one of its
 * words appears nowhere in the draft, in any case.
 */
export function addedFacts(before: OutreachOutput, after: OutreachOutput): string[] {
  const was = proseText(before);
  const now = proseText(after);
  const known = new Set(words(was));
  // Whole numbers, not substrings: "15" becoming "5" is a changed figure.
  const numbersOf = (text: string) => (text.match(/(?<![\d.,])\d[\d,.]*%?/g) ?? []).map((n) => n.replace(/[.,]$/, ""));
  const earlier = new Set(numbersOf(was));
  const numbers = numbersOf(now).filter((n) => !earlier.has(n));
  const names = proseParts(after).flatMap((part) => namedEntities(part)).filter((entity) => words(entity).some((word) => !ORDINARY.has(word) && !CALENDAR.has(word) && !known.has(word)));
  return [...new Set([...numbers, ...names])];
}
