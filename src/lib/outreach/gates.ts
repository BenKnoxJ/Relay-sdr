import type { EvidenceQuote, OutreachInput } from "../../../agents/outreach/input.schema";
import { SENDER_ASIDE_KINDS } from "@/lib/outreach/asideKinds";
import { hostOf } from "../../../agents/_shared/item.schema";
import { checkTouchLimits, type MessageDraft, type OutreachOutput } from "../../../agents/outreach/output.schema";
import type { NeverSayFile } from "@/lib/facts/neverSay";
import { neverSayIssues } from "@/lib/facts/neverSay";

import { genderedPronouns, namesProduct } from "./messageChecks";

/**
 * The checks on a drafted touch (outreach standard v3, 28 Sep 2026).
 *
 * Tier A holds a draft, and only for the eight truth checks, which are the same for every campaign:
 *
 *   1. a price anywhere but the call script's objection answers;
 *   2. a product claim that is not in the facts file;
 *   3. a quote or attributed finding that is not word for word from the campaign's evidence, or names no source;
 *   4. invented experience, customers or results;
 *   5. a firm, person, number or line of business that is not in the data;
 *   6. a colleague at the same firm already sent the same evidence item;
 *   7. a link or a gender guess (the drafting tool's name is refused by the output schema);
 *   8. a touch that is empty, the wrong shape or over its length.
 *
 * Everything about style is Tier B: a warning on the card, never a hold. The rep reads every draft.
 *
 * Nothing here knows the campaign. Sources come from `pack.evidence`, lines of business from the lookup and
 * the campaign's industries, prices from the facts file. A new market needs new research, not new code.
 */

export type Finding = { rule: string; text: string };
export type GateResult = { tierA: Finding[]; tierB: Finding[] };

/** Which truth check each Tier A rule is. A Tier A finding whose rule is not here is a bug. */
export const TRUTH_CHECKS: Readonly<Record<string, 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8>> = {
  "price-in-message": 1,
  "claim-id": 2,
  "claim-number": 2,
  "never-say": 2,
  "unsupported-source-claim": 3,
  "invented-experience": 4,
  "unsourced-name": 5,
  "unsourced-number": 5,
  "firm-line": 5,
  "opener-ref": 5,
  "opener-usable": 5,
  "colleague-evidence": 6,
  link: 7,
  "gendered-pronoun": 7,
  length: 8,
  kind: 8,
  voicemail: 8,
  "second-call": 8,
};

/** A draft already written in this campaign. `personId` is who it was for: repetition counts people, not drafts. */
export type CohortDraft = { body: string; ask: string; sameAccount: boolean; personId: string; touch?: string };

export type GateContext = {
  /** The product's name as the rep says it; always allowed in a body. */
  productNames: readonly string[];
  /** The rep's own name. */
  repName: string;
  /** The campaign's other drafts, newest first. */
  cohort: readonly CohortDraft[];
  /** The product's never-say list. */
  neverSay?: Pick<NeverSayFile, "entries">;
};

// ---------------------------------------------------------------------------
// Text helpers

const SENTENCE = /[^.?!]+[.?!]+|[^.?!]+$/g;

export function sentences(text: string): string[] {
  return (text.replace(/\s+/g, " ").trim().match(SENTENCE) ?? []).map((s) => s.trim()).filter((s) => s.length > 0);
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

/** A tell-list entry in a text: a multi-word entry as a substring, a single word with its ordinary stems. */
export function hasTell(text: string, phrase: string): boolean {
  const wanted = phrase.trim().toLowerCase();
  if (wanted === "") return false;
  const haystack = text.toLowerCase().replace(/[’]/g, "'").replace(/\s+/g, " ");
  if (/\s/.test(wanted)) return haystack.includes(wanted.replace(/\s+/g, " "));
  return new RegExp(`(^|[^a-z0-9])${escape(wanted)}(?:s|es|d|ed|ing|ly|ment|ments)?($|[^a-z0-9])`).test(haystack);
}

const clip = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max - 1)}…`);

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

/**
 * The words a rep reads on a touch, part by part: a message's subject and body, or a call script's lines.
 * Kept apart so a subject without a full stop does not run into the body as one sentence.
 */
export function proseParts(draft: OutreachOutput): string[] {
  if (draft.kind === "message") return [draft.subject ?? "", draft.body].filter((part) => part !== "");
  const point = draft.talkingPoint;
  return [...callLines(point), ...(point.objections ?? []).flatMap((pair) => [pair.objection, pair.answer]).filter((part) => part !== "")];
}

type TalkingPoint = Extract<OutreachOutput, { kind: "call" }>["talkingPoint"];

/** A call script's own lines, without its objection pairs. */
function callLines(point: TalkingPoint): string[] {
  return [point.openingLine, point.oneQuestion, point.openingLine2 ?? "", point.oneQuestion2 ?? "", point.listenFor, point.voicemail ?? ""].filter((part) => part !== "");
}

/** The same, as one text. */
export function proseText(draft: OutreachOutput): string {
  return proseParts(draft).join("\n");
}

const allSentences = (parts: readonly string[]) => parts.flatMap((part) => sentences(part));

// ---------------------------------------------------------------------------
// 1. Price

const CURRENCY = /[£$€]\s?\d|\b(?:gbp|usd|eur)\s?\d/i;
/** A price or a contract term. "Month to month" alone is ordinary English ("volumes swing month to month"), so not here. */
const PRICE = new RegExp(`${CURRENCY.source}|\\bper (?:seat|user|licence|license)\\b|\\bset-?up fee\\b|\\bseat minimum\\b|\\bno (?:annual )?(?:lock-in|contract)\\b`, "i");

/** The facts that state a price: any fact whose text carries a currency amount. */
function priceFactIds(input: OutreachInput): Set<string> {
  return new Set(input.facts.facts.filter((fact) => CURRENCY.test(fact.text)).map((fact) => fact.id));
}

function priceFindings(draft: OutreachOutput, input: OutreachInput): Finding[] {
  // A call's objection answers are the one place a price belongs: the complete answer to a price question.
  const parts = draft.kind === "call" ? callLines(draft.talkingPoint) : proseParts(draft);
  const prices = priceFactIds(input);
  const citesPrice = draft.kind === "message" && draft.claims.some((claim) => prices.has(claim));
  if (!citesPrice && !parts.some((part) => PRICE.test(part))) return [];
  return [{ rule: "price-in-message", text: "This carries a price, a fee or a contract term. Price belongs only in the call script, as the answer to a price question." }];
}

// ---------------------------------------------------------------------------
// 3. Evidence, word for word

/** How many consecutive words of a source's own wording count as carrying it. */
export const QUOTE_RUN_WORDS = 6;
/** The shortest quoted fragment that is a quote: `firms "did not always measure the impact" of…`. */
export const QUOTE_FRAGMENT_WORDS = 4;

/** Every run of `QUOTE_RUN_WORDS` words in the evidence list, normalised. */
export function quoteRuns(evidence: readonly EvidenceQuote[], run: number = QUOTE_RUN_WORDS): Set<string> {
  const runs = new Set<string>();
  for (const item of evidence) {
    const list = quoteWords(item.quote);
    for (let i = 0; i + run <= list.length; i += 1) runs.add(list.slice(i, i + run).join(" "));
  }
  return runs;
}

/** True when a text carries a run of the evidence list's own wording. */
export function quotesEvidence(text: string, runs: ReadonlySet<string>, run: number = QUOTE_RUN_WORDS): boolean {
  const list = quoteWords(text);
  for (let i = 0; i + run <= list.length; i += 1) {
    if (runs.has(list.slice(i, i + run).join(" "))) return true;
  }
  return false;
}

/** Spans in quote marks: double quotes, curly quotes, or straight single quotes at a word's edge ("firms' calls" is not one). */
const QUOTED = /(?:^|[\s(:,])(?:"([^"]+)"|“([^”]+)”|‘(.+?)’(?=$|[\s.,;:?!)])|'([^']+)'(?=$|[\s.,;:?!)]))/g;

export function quotedSpans(text: string): string[] {
  return [...text.matchAll(QUOTED)].map((match) => (match[1] ?? match[2] ?? match[3] ?? match[4] ?? "").trim()).filter((span) => span !== "");
}

/** True when a span is a run of a quote's own words, exactly, in order. */
export function isFragmentOf(span: string, quote: EvidenceQuote): boolean {
  const mine = quoteWords(span);
  const theirs = quoteWords(quote.quote);
  if (mine.length === 0 || mine.length > theirs.length) return false;
  for (let i = 0; i + mine.length <= theirs.length; i += 1) {
    if (mine.every((word, j) => theirs[i + j] === word)) return true;
  }
  return false;
}

/** The quoted fragments of at least `QUOTE_FRAGMENT_WORDS` words a text carries from one quote. */
function fragmentsFrom(text: string, quote: EvidenceQuote): string[] {
  return quotedSpans(text).filter((span) => quoteWords(span).length >= QUOTE_FRAGMENT_WORDS && isFragmentOf(span, quote));
}

/** Which evidence quotes a text carries, by id: what a colleague at the same firm has already used. */
export function evidenceUsedIn(text: string, evidence: readonly EvidenceQuote[]): string[] {
  return evidence.filter((quote) => quotesEvidence(text, quoteRuns([quote])) || fragmentsFrom(text, quote).length > 0).map((quote) => quote.id);
}

/** Host labels that say nothing about who a source is. */
const HOST_NOISE = new Set("www com org net co uk gov ac io eu info biz ltd plc int".split(" "));
/** Words in a source's name that say nothing about who it is. */
const NAME_NOISE = new Set(
  "the a an of and for to in on by at its it's their review reviews report reports figures data quarterly annual published publication research survey study site page website news".split(" "),
);

/**
 * The names a quote's source goes by: its host without the public suffix, whole ("fca" from fca.org.uk,
 * "financial ombudsman" from financial-ombudsman.org.uk), and the proper nouns of a `sourceName` a person gave
 * it ("FCA" in "the FCA's root cause review of 40 firms", never "firms"). A sentence naming any of them names
 * the source. Whole, so a page at fca-insight-hub.com is named "fca insight hub" and never passes as the FCA
 * (Sentinel CWE-345). Read from the evidence, never a list.
 */
function sourceWords(quote: EvidenceQuote): string[] {
  const whole = hostOf(quote.url);
  const labels = whole.split(".").filter((label) => !HOST_NOISE.has(label));
  const label = labels.at(-1)?.replace(/-/g, " ");
  const pinned = label === undefined ? undefined : BODY_HOSTS[label];
  const host = label === undefined ? [] : pinned === undefined || whole === pinned || whole.endsWith(`.${pinned}`) ? [label] : [whole];
  const name = (quote.sourceName.match(/\b[A-Z][A-Za-z0-9&]*/g) ?? []).map((word) => word.toLowerCase()).filter((word) => !NAME_NOISE.has(word) && !MONTHS.has(word));
  return [...new Set([...host, ...name].filter((word) => word.length >= 2))];
}

/**
 * The bodies a bare host label could pass for, and the one host each is at. A same-label host anywhere else
 * (fca.com, fca.co.uk, news.fca.net, ombudsman.co.uk) is named by its whole host, never as the body
 * (Sentinel CWE-345; the base pinned these hosts too).
 */
const BODY_HOSTS: Readonly<Record<string, string>> = {
  fca: "fca.org.uk",
  "financial conduct authority": "fca.org.uk",
  ombudsman: "financial-ombudsman.org.uk",
  "financial ombudsman": "financial-ombudsman.org.uk",
  fos: "financial-ombudsman.org.uk",
};

const MONTHS = new Set("january february march april may june july august september october november december".split(" "));

/** True when a sentence names this quote's source. `own` names the reader's firm, for a quote from its own site. */
function namesSource(sentence: string, quote: EvidenceQuote, own: readonly string[]): boolean {
  if (sourceWords(quote).some((word) => hasPhrase(sentence, word))) return true;
  return own.some((phrase) => phrase.trim() !== "" && hasPhrase(sentence, phrase.trim()));
}

/**
 * A sentence reporting what someone found. Active verbs only: "what was said on the call" and "the calls are
 * found late" are not findings.
 */
const REPORTS =
  /(?<!\b(?:is|are|was|were|be|been|being|get|gets|got|getting|often|usually|rarely|only)\s)\b(?:found|finds|find that|reported|reports that|according to|concluded|concludes|surveyed|showed|shows that|published|publishes|highlighted|noted that|one of (?:its|their) (?:points|findings))\b/i;

const FIGURE = /\d[\d,.]*\s?%|\d[\d,]*/;

/** A text with the given names taken out, so "Insights360" is a product and not the figure 360. */
function withoutNames(text: string, names: readonly string[]): string {
  let out = text;
  for (const name of [...names].sort((a, b) => b.length - a.length)) {
    if (name.trim() === "") continue;
    out = out.replace(new RegExp(`(^|[^a-z0-9])${escape(name.trim())}(?=$|[^a-z0-9])`, "gi"), "$1 ");
  }
  return out;
}

/**
 * True when a sentence makes a claim about a source: it reports a finding, a body "says" something, it names
 * one of the evidence's sources together with a figure, or it writes a source's name as the one holding a view
 * ("The FCA flagged…", "The FCA thinks…", "The FCA's view is…"), whatever the verb. A question asserts nothing,
 * and offering the document ("happy to send the FCA's write-up") says nothing it found. `about` is the reader's
 * firm: a quote from its own site is not a third party's view.
 */
export function attributesASource(sentence: string, names: readonly string[] = [], evidence: readonly EvidenceQuote[] = [], about: readonly string[] = []): boolean {
  if (sentence.trim().endsWith("?")) return false;
  const plain = withoutNames(sentence, names);
  const namesEvidence = evidence.some((quote) => sourceWords(quote).some((word) => hasPhrase(sentence, word)));
  if (reportsByThirdParty(sentence, REPORTS)) return true;
  // "Says" only with an evidence source named: "the FCA says…" is a claim, "what was said on the call" is not.
  if (namesEvidence && reportsByThirdParty(sentence, SAYS)) return true;
  if (FIGURE.test(plain) && namesEvidence) return true;
  const thirdParty = evidence.filter((quote) => ownSiteNames(quote, about).length === 0);
  return writesSourceName(sentence, thirdParty) && !OFFERS_DOCUMENT.test(sentence);
}

/** Offering a source's document, not reporting it: "I can send over the FCA's write-up on root cause work". */
const OFFERS_DOCUMENT =
  /\b(?:send|sending|share|sharing|pass(?:ing)? on|forward|forwarding)\b.*\b(?:write-?up|review|report|paper|summary|guidance|piece|link)s?\b/i;

/**
 * True when a sentence writes a quote's source as a name: capitalised ("the FCA", "Financial Ombudsman"), and
 * not a capital that only starts the sentence unless it is an acronym. So a host label that is an ordinary word
 * ("which", "complaints") is not a source named outright every time the word is used.
 */
function writesSourceName(sentence: string, evidence: readonly EvidenceQuote[]): boolean {
  return evidence.some((quote) =>
    sourceWords(quote).some((word) => {
      const pattern = new RegExp(`(^|[^A-Za-z0-9])(${escape(word).replace(/\s+/g, "\\s+")})(?=$|[^A-Za-z0-9])`, "gi");
      for (const match of sentence.matchAll(pattern)) {
        const written = match[2]!.split(/\s+/);
        const first = sentence.slice(0, match.index + match[1]!.length).trim() === "";
        if (written.every((part) => /^[A-Z]/.test(part)) && (!first || /^[A-Z0-9&]{2,}$/.test(written[0]!))) return true;
      }
      return false;
    }),
  );
}

/** The rep, the reader or their team as the one reporting: "I found…", "your team reported…". Never a source. */
const OWN_SUBJECT = /\b(?:i|we|you|your|our|my)\b(?:\s+[\w'’-]+){0,2}\s*$/i;

/** True when a reporting verb in the sentence has someone other than the rep or the reader as its subject. */
function reportsByThirdParty(sentence: string, verbs: RegExp): boolean {
  const pattern = new RegExp(verbs.source, "gi");
  for (const match of sentence.matchAll(pattern)) {
    if (!OWN_SUBJECT.test(sentence.slice(0, match.index))) return true;
  }
  return false;
}

const SAYS = /\b(?:says|said|states|stated|warns|warned)\b/i;

/**
 * The sentences that quote or attribute without the campaign's evidence behind them. A sentence passes when:
 *
 *   * every span it puts in quote marks (four words or more) is a quote's own words, exactly, and names that
 *     quote's source in the same sentence;
 *   * and, when it reports a finding, it carries a quote (six words of its wording, or a quoted fragment)
 *     from a source it names.
 *
 * `about` is the reader's firm and name: a sentence about them, naming no source, is the lookup's business
 * and checked as a firm fact. `names` are the input's own words, never read as a figure.
 */
export function unsupportedSourceClaims(parts: readonly string[], evidence: readonly EvidenceQuote[], about: readonly string[] = [], names: readonly string[] = []): string[] {
  const held: string[] = [];
  const hold = (sentence: string) => {
    if (!held.includes(sentence)) held.push(sentence);
  };
  for (const sentence of allSentences(parts)) {
    // What is in quote marks is somebody's words: whose?
    const spans = quotedSpans(sentence).filter((span) => quoteWords(span).length >= QUOTE_FRAGMENT_WORDS);
    const badSpan = spans.some((span) => {
      const from = evidence.filter((quote) => isFragmentOf(span, quote));
      return from.length === 0 || !from.some((quote) => namesSource(sentence, quote, ownSiteNames(quote, about)));
    });
    if (badSpan) {
      hold(sentence);
      continue;
    }
    if (!attributesASource(sentence, names, evidence, about)) continue;
    const named = evidence.filter((quote) => namesSource(sentence, quote, ownSiteNames(quote, about)));
    const aboutReader = about.some((phrase) => phrase.trim() !== "" && hasPhrase(sentence, phrase.trim())) || /^\s*(?:you|your)\b/i.test(sentence);
    if (named.length === 0 && aboutReader) continue;
    const carried = named.some((quote) => quotesEvidence(sentence, quoteRuns([quote])) || fragmentsFrom(sentence, quote).length > 0);
    if (!carried) hold(sentence);
  }
  return held;
}

/** A quote from the reader's own site is named by their firm's name. */
function ownSiteNames(quote: EvidenceQuote, about: readonly string[]): readonly string[] {
  const host = hostOf(quote.url);
  return about.some((phrase) => phrase.trim() !== "" && host.includes(phrase.toLowerCase().replace(/[^a-z0-9]/g, ""))) ? about : [];
}

/** Words too common to say which quote a sentence was reaching for. */
const QUOTE_STOP = new Set(
  "the a an and or of to in on for by with at as is are was were be been it its it's this that these those their they them from not but have has had can could would should will may might more most some any each every all no firms firm".split(" "),
);

/** The evidence item a held sentence was paraphrasing: the one sharing the most distinctive words, at least three. */
export function closestQuote(sentence: string, evidence: readonly EvidenceQuote[]): EvidenceQuote | null {
  const distinct = (text: string) => quoteWords(text).map((word) => word.replace(/'s$/, "")).filter((word) => !QUOTE_STOP.has(word));
  const mine = new Set(distinct(sentence));
  let best: { quote: EvidenceQuote; shared: number } | null = null;
  for (const quote of evidence) {
    const shared = new Set(distinct(`${quote.sourceName} ${quote.quote}`).filter((word) => mine.has(word))).size;
    if (shared >= 3 && (best === null || shared > best.shared)) best = { quote, shared };
  }
  return best?.quote ?? null;
}

/** The longest a finding may be and still reach the corrective call whole (the redraft carries 500 characters). */
export const SOURCE_FIX_MAX_CHARS = 470;

export function sourceClaimFix(sentence: string, quote: EvidenceQuote | null): string {
  const said = `"${clip(sentence, 90)}" quotes or reports a source without its exact words and its name.`;
  if (quote === null) return `${said} Nothing in the evidence says this: make the point in plain words with no source, or leave it out.`;
  const whole = `${said} Use this quote exactly, naming ${quote.sourceName}: "${quote.quote}". Or leave the source out.`;
  return whole.length <= SOURCE_FIX_MAX_CHARS ? whole : `${said} Use evidence item ${quote.id} exactly, word for word, and name its source. Or leave the source out.`;
}

// ---------------------------------------------------------------------------
// 4. Invented experience, customers or results

/**
 * The one light line about the rep (Benny-san, 28 Sep 2026): "I've been helping a few <firms> get a proper
 * look at calls like that." True, and allowed in any touch. It is the only claim about the rep's work a
 * draft may make.
 */
const ASIDE = /\b(?:i|we)(?:['’]ve| have)?\s+(?:(?:been\s+)?help(?:ed|ing)|spent (?:a while|some time|a lot of time) helping)\b|^\s*been helping\b/i;
/** A result claimed for anyone: what turns the aside, or any line, into an invented outcome. */
const RESULT = /\b(?:reduc(?:e|ed|es|ing)|cut(?:s|ting)?\b(?!\s+(?:through|across|to the chase))|by (?:a )?(?:half|third|quarter)|sav(?:e|ed|es|ing) (?:them|their|hours|time|money)|halv(?:e|ed|es|ing)|doubl(?:e|ed|es|ing))\b|\d+\s*%|\b\d+x\b/i;

/** A manufactured relationship or track record: people the rep "speaks to", "our clients", what "we tend to see". */
const INVENTED: readonly RegExp[] = [
  // Any kind of firm: "insurers we work with", "other lenders I speak to". Never "unless I talk to…".
  /\b(?!(?:this|thus|does|was|has|yes|always|perhaps|sometimes|whereas|besides|towards|afterwards|its|his|hers|ours|yours|theirs)\b)[a-z]+s(?<!ss|us|is) (?:i|we)(?:['’]ve| have)? (?:speak|talk|work|spoke|talked|worked|chat)(?:ed|ing)? (?:to|with)\b/i,
  /\b(?:i|we) (?:speak|talk|work) (?:to|with) (?:a lot of|lots of|many|most|plenty of|dozens of|hundreds of)\b/i,
  /\bwhat (?:we|i) (?:tend to|usually|often|typically|keep|always) (?:see|hear|find)\b/i,
  /\b(?:our|my) (?:clients|customers)\b/i,
  /\b(?:a|one) (?:client|customer) of (?:ours|mine)\b/i,
  /\b(?:that|it) stuck with me\b/i,
];

/** The kind of firm the light line names: "a few insurers", "some lenders like yours". */
const ASIDE_KIND = /\bhelp(?:ed|ing)\s+(?:a few|a couple of|some|several|a handful of)\s+((?:[a-z-]+\s+)?[a-z-]+)/i;
/** Words that follow the kind of firm rather than name it: "a few insurers get…", "a few firms keep…". */
const AFTER_KIND = new Set("get gets cut cuts keep keeps make makes see sees look looks work works find finds sort deal handle stay with like to on in across who that for and".split(" "));
/** Nouns that name no kind of firm, so they are true of any campaign. */
const ANY_KIND = new Set("firms firm teams team companies company businesses business people organisations folks".split(" "));

/**
 * The kinds of firm the rep truly helps, which the light line may name (Benny-san, 28 Sep: "insurers"; any
 * word in `ANY_KIND`, such as "firms", is always true). Sender data, never derived from the recipient or the
 * campaign: "a few care home groups" would be a claim about the rep's work nobody has confirmed.
 */
export { SENDER_ASIDE_KINDS };

/** True when the light line names a kind of firm the rep has not said they help. */
function asideOffCampaign(sentence: string): boolean {
  const kind = (ASIDE_KIND.exec(sentence)?.[1]?.toLowerCase().split(/\s+/) ?? []).filter((word) => !AFTER_KIND.has(word)).at(-1);
  if (kind === undefined || ANY_KIND.has(kind)) return false;
  return !SENDER_ASIDE_KINDS.some((allowed) => allowed === kind || allowed === `${kind}s`);
}

function inventedFindings(parts: readonly string[]): Finding[] {
  const list = allSentences(parts);
  const invented = list.find(
    (sentence) => INVENTED.some((pattern) => pattern.test(sentence)) || (ASIDE.test(sentence) && (RESULT.test(sentence) || asideOffCampaign(sentence))),
  );
  if (invented === undefined) return [];
  return [
    {
      rule: "invented-experience",
      text: `"${clip(invented, 90)}" claims experience, customers or results nothing in the data supports. The one line allowed is that you've been helping a few of the kind of firm this campaign is aimed at, with no result in it.`,
    },
  ];
}

// ---------------------------------------------------------------------------
// 5. Firms, people, numbers and lines of business that are in the data

/** Capitalised words that are ordinary English whatever their position. */
const ORDINARY = new Set(
  "i i'm i've i'd i'll we we're we've our you you're your yours they their it it's its this that these those the a an and but or if when while what which who how why where there here is are was were be been has have had do does did can could would should will may might most many much more some any each every all no not one two three hi hello hey thanks thank best regards kind cheers mr mrs ms dr".split(
    " ",
  ),
);

/** Calendar words and the country Relay writes from: never a claim about anyone. */
const CALENDAR = new Set(
  "january february march april may june july august september october november december monday tuesday wednesday thursday friday saturday sunday spring summer autumn winter uk british britain england scotland wales ireland london".split(
    " ",
  ),
);

/** Where a touch is sent and how people talk: never a claim about anyone. Multi-word names first. */
export const CHANNEL_WORDS = ["microsoft teams", "microsoft outlook", "google meet", "linkedin", "inmail", "outlook", "teams", "zoom", "whatsapp", "slack", "gmail", "email", "e-mail"] as const;

function withoutChannels(entity: string): string {
  let out = entity.toLowerCase();
  for (const channel of CHANNEL_WORDS) out = out.replace(new RegExp(`(^|[^a-z0-9])${escape(channel)}($|[^a-z0-9])`, "g"), "$1 $2");
  return out;
}

/** The names and values the input already carries, which a body may always use. */
function allowedValues(input: OutreachInput, context: GateContext): string[] {
  return [
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

/** Everything a draft may cite: the lookup, the plan, the evidence, the facts, the role and the campaign. */
function evidenceRaw(input: OutreachInput): string {
  const pack = input.pack;
  return [
    ...input.lookup.items.flatMap((item) => [item.text, item.quote ?? ""]),
    ...(input.lookup.lines ?? []),
    pack.archetype.situation,
    ...pack.archetype.pains.flatMap((pain) => [pain.text, pain.quote ?? ""]),
    ...pack.archetype.language.map((phrase) => phrase.text),
    pack.hook?.text ?? "",
    pack.hook?.whyNow.text ?? "",
    ...pack.angles.map((angle) => angle.text),
    ...pack.doDont.flatMap((line) => [line.use, line.avoid]),
    ...pack.verbatim.flatMap((item) => [item.text, item.quote ?? ""]),
    ...pack.evidence.flatMap((item) => [item.quote, item.sourceName, hostOf(item.url)]),
    ...pack.proof.map((proof) => proof.text),
    ...input.facts.facts.map((fact) => fact.text),
    input.buyerRole?.needs ?? "",
    input.account.seedEvidence ?? "",
    ...(input.campaign?.industries ?? []),
    ...(input.campaign?.groups ?? []).flat(),
  ].join("\n");
}

/** Words that commonly open an English sentence or an offer. Never a name, whatever their case. */
const STARTERS = new Set(
  "shall want need fancy keen mind open so also just still yet even only then now perhaps maybe happy glad worth given since because after before once until unless although though whether few several last next first second finally often usually sometimes currently recently today honestly curious fair sounds seems looks feel saw been thought mostly funny wondering reckon probably hopefully reading looking seeing having being going no worries".split(
    " ",
  ),
);

function isOpener(token: string): boolean {
  const word = token.toLowerCase().replace(/['’]s$/, "");
  return ORDINARY.has(word) || STARTERS.has(word);
}

/** Runs of capitalised or numeric tokens that are not merely a sentence's first word. */
export function namedEntities(body: string): string[] {
  const found: string[] = [];
  for (const sentence of sentences(body)) {
    const tokens = sentence
      .split(/\s+/)
      .map((token) => token.replace(/^[("'“‘]+|[)"'”’.,;:?!]+$/g, ""))
      .filter((token) => token !== "");
    let run: { text: string; index: number }[] = [];
    const flush = () => {
      if (run.length > 1 && run[0]!.index === 0 && isOpener(run[0]!.text)) run = run.slice(1);
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

function provenanceFindings(part: string, input: OutreachInput, context: GateContext): Finding[] {
  const found: Finding[] = [];
  const allowed = new Set(allowedValues(input, context).flatMap((value) => words(value)));
  const evidence = evidenceRaw(input).toLowerCase();
  const unsourced = (entity: string) => {
    const tokens = words(withoutChannels(entity)).filter((token) => !ORDINARY.has(token) && !CALENDAR.has(token) && !allowed.has(token));
    if (tokens.length === 0) return false;
    return !hasPhrase(evidence, tokens.join(" ")) && !tokens.every((token) => hasPhrase(evidence, token));
  };
  const names = namedEntities(part).filter(unsourced);
  if (names.length > 0) found.push({ rule: "unsourced-name", text: `It names ${names.map((n) => `"${n}"`).join(", ")}, which is not in the lookup, the plan or the facts.` });
  const allowedDigits = words([...allowed].join(" "));
  const numbers = (part.match(/\d[\d,.]*%?/g) ?? []).map((n) => n.replace(/[.,]$/, ""));
  const missing = numbers.filter((n) => !evidence.includes(n.toLowerCase()) && !allowedDigits.includes(n.toLowerCase()));
  if (missing.length > 0) found.push({ rule: "unsourced-number", text: `The number ${missing.join(", ")} traces to nothing in the lookup, the plan or the facts.` });
  return found;
}

/** Plain English words that never say which line of business a firm is in, whatever the market. */
const NOT_A_LINE = new Set(
  "and the for with from other general specialist specialists commercial personal private independent leading large small direct national regional managing managed management services service providers provider agents agent companies company firms firm business businesses organisations non standard third party lines line outsourced delegated authority".split(" "),
);

const labelWords = (label: string) => label.toLowerCase().match(/[a-z]+/g) ?? [];

/** The words of a list of industry labels. */
export function lineWordsOf(labels: readonly string[]): string[] {
  return [...new Set(labels.flatMap(labelWords).filter((word) => word.length >= 3 && !NOT_A_LINE.has(word)))];
}

/**
 * A campaign's line-of-business vocabulary, from its own data (standard v3, truth check 5).
 *
 * The research's groups (m04) each carry industry labels. A word that recurs across groups is the sector
 * ("insurance" in "Motor insurance" and "Travel insurance"); the word just before it in a label is a line
 * ("motor", "travel"), and "Home and buildings insurance" gives both "home" and "buildings". `own` is every
 * word of the confirmed group's labels (the group m04 holds them in), which is never a contradiction; `all` is
 * every group's lines, and `phrases` each line as the labels say it ("motor insurance"), which is what the
 * lookup counts on a page. With one group nothing recurs, so there are no lines and nothing to contradict.
 * Nothing here knows any market.
 */
export function lineVocabularyOf(campaign: OutreachInput["campaign"]): { own: string[]; all: string[]; sector: string[]; phrases: Record<string, string[]> } {
  const industries = campaign?.industries ?? [];
  const groups = [...(campaign?.groups ?? [])];
  const ownGroup = groups.find((group) => industries.every((label) => group.includes(label))) ?? industries;
  if (!groups.includes(ownGroup)) groups.push(ownGroup);
  const counts = new Map<string, number>();
  for (const group of groups) for (const word of new Set(group.flatMap(labelWords))) counts.set(word, (counts.get(word) ?? 0) + 1);
  const sector = new Set([...counts].filter(([word, count]) => count >= 2 && word.length >= 3 && !NOT_A_LINE.has(word)).map(([word]) => word));
  const phrases: Record<string, Set<string>> = {};
  const linesIn = (labels: readonly string[]) =>
    labels.flatMap((label) => {
      const list = labelWords(label);
      const found: string[] = [];
      const add = (term: string | undefined, at: string) => {
        if (term === undefined || term.length < 3 || NOT_A_LINE.has(term) || sector.has(term)) return;
        found.push(term);
        (phrases[term] ??= new Set()).add(`${term} ${at}`);
      };
      list.forEach((word, index) => {
        if (!sector.has(word) || index === 0) return;
        add(list[index - 1], word);
        // "Home and buildings insurance": the word before the "and" is a line too.
        if (index >= 3 && (list[index - 2] === "and" || list[index - 2] === "or")) {
          add(list[index - 3], word);
          // A page says the label's own words ("home and buildings insurance"), which count for both lines.
          for (const term of [list[index - 3]!, list[index - 1]!]) phrases[term]?.add(list.slice(index - 3, index + 1).join(" "));
        }
      });
      return found;
    });
  const allLines = [...new Set(groups.flatMap((group) => linesIn(group)))];
  const own = [...new Set(ownGroup.flatMap(labelWords))];
  return { own, all: allLines, sector: [...sector], phrases: Object.fromEntries(Object.entries(phrases).map(([term, set]) => [term, [...set]])) };
}

/** The nouns that make a line of business a claim about a firm: "a travel firm", "at a motor insurer". */
const FIRM_NOUN = "(?:insurers?|underwriters?|firms?|compan(?:y|ies)|brokers?|lenders?|banks?|retailers?|operators?|business(?:es)?|specialists?|providers?|side|complaints)";

/**
 * The lines of `vocabulary` a text uses as a firm's line, "<line> [sector word] <firm noun>": "Complaints at a
 * motor insurer must be an odd job" uses "motor", and so do "a home and motor insurer" and "a motor insurance firm".
 */
export function lineClaimsIn(text: string, vocabulary: readonly string[], sector: readonly string[] = []): string[] {
  const between = sector.length === 0 ? "" : `(?:(?:${sector.map(escape).join("|")})\\s+)?`;
  return vocabulary.filter((word) => new RegExp(`\\b${escape(word)}\\s+(?:(?:and|&|or)\\s+[a-z-]+\\s+)?${between}${FIRM_NOUN}\\b`, "i").test(text));
}

/**
 * Truth check 5's line of business: a draft that puts the reader's firm in a line the data does not give it.
 * The firm's known lines are the lookup's `lines`, or with none the confirmed group's. A question asks rather
 * than says, so it is not read. The light line about the rep names the firms the rep helps, which must be the
 * campaign's own kind (check 4 reads its noun), so its lines are read against the campaign's, not the firm's.
 */
function firmLineFindings(parts: readonly string[], input: OutreachInput): Finding[] {
  const { own, all, sector } = lineVocabularyOf(input.campaign);
  // The firm's lines are only what the trigger search found (28 Sep): never the campaign's, which is how a travel
  // insurer was told "Complaints at a motor insurer must be an odd job". Unknown stays unknown, and the light line
  // about the rep ("a few insurers") names no line the firm is not known to be in.
  void own;
  const firm = lineWordsOf(input.lookup.lines ?? []);
  const named = new Set(words(`${input.person.company} ${input.account.company} ${input.person.domain ?? ""}`));
  const known = new Set([...firm, ...named]);
  const vocabulary = [...new Set([...all, ...firm])];
  if (vocabulary.length === 0) return [];
  for (const sentence of allSentences(parts)) {
    if (sentence.trim().endsWith("?")) continue;
    const wrong = lineClaimsIn(sentence, vocabulary.filter((word) => !known.has(word)), sector);
    if (wrong.length > 0) {
      const what = firm.length > 0 ? `what the search found about ${input.person.company}` : `known about ${input.person.company} (nothing is)`;
      return [{ rule: "firm-line", text: `"${clip(sentence, 90)}" says the firm is in ${wrong.join(", ")}, which is not ${what}. Say only what the data says about the firm.` }];
    }
  }
  return [];
}

// ---------------------------------------------------------------------------
// 6. Colleagues

function colleagueFindings(draft: OutreachOutput, input: OutreachInput, context: GateContext): Finding[] {
  const used = input.pack.evidence.filter((quote) => evidenceUsedIn(proseText(draft), [quote]).length > 0);
  const colleagues = context.cohort.filter((other) => other.sameAccount);
  const shared = used.find((quote) => colleagues.some((other) => evidenceUsedIn(other.body, [quote]).length > 0));
  return shared === undefined
    ? []
    : [{ rule: "colleague-evidence", text: `A colleague at this firm was already sent the quote from ${shared.sourceName}. Use a different one, or a plain point with no source.` }];
}

// ---------------------------------------------------------------------------
// Tier B: style, on the card and never a hold

/** A time or meeting ask, a meeting length or a calendar link. */
const TIME_ASK = [
  /\b\d+\s*(?:-|to)?\s*(?:\d+\s*)?(?:min|mins|minute|minutes)\b/i,
  /\b(?:fifteen|twenty|thirty|ten|five)[- ]minutes?\b/i,
  /\bhalf an hour\b/i,
  /\b(?:next|this) week\b/i,
  /\btomorrow\b/i,
  /\bcalend(?:ar|ly)\b/i,
  /\bin (?:your|the) diary\b/i,
  /\bbook (?:a|some|in a) (?:call|meeting|time|slot|demo)\b/i,
  /\b(?:grab|find) (?:a|some) time\b/i,
];

/** The contrast cadence: "isn't X, it's Y", "not X, but Y", "is a separate question", "says nothing about". */
const CONTRAST: readonly RegExp[] = [
  /\b(?:isn't|is not|aren't|are not|wasn't|was not|it's not|it is not)\b[^.?!]{0,80}[.;,]\s*(?:it's|it is|they're|they are|this is|that's|that is)\b/i,
  /\bnot (?:just |only |simply )?[^.,?!]{1,50}, but\b/i,
  /\b(?:is|are|'s|’s)\s+(?:a\s+)?(?:separate|different|whole other)\s+(?:question|job|matter|problem|story)\b/i,
  /\bis one thing\b[^.?!]*\banother\b/i,
  /\b(?:says?|tells?(?:\s+you)?|shows?(?:\s+you)?)\s+nothing (?:about|of)\b/i,
];

/** Non-British spellings, each with the British spelling to use. */
const US_SPELLINGS: readonly (readonly [RegExp, string, string])[] = [
  ...(
    [
      ["organize", "organise"], ["organized", "organised"], ["organization", "organisation"], ["prioritize", "prioritise"], ["analyze", "analyse"],
      ["analyzed", "analysed"], ["optimize", "optimise"], ["realize", "realise"], ["recognize", "recognise"], ["specialize", "specialise"],
      ["specialized", "specialised"], ["customize", "customise"], ["apologize", "apologise"], ["standardize", "standardise"], ["summarize", "summarise"],
      ["utilize", "use"], ["maximize", "maximise"], ["minimize", "minimise"], ["emphasize", "emphasise"], ["color", "colour"], ["behavior", "behaviour"],
      ["favor", "favour"], ["favorite", "favourite"], ["honor", "honour"], ["labor", "labour"], ["center", "centre"], ["centers", "centres"],
      ["defense", "defence"], ["catalog", "catalogue"], ["modeling", "modelling"], ["traveling", "travelling"], ["canceled", "cancelled"],
      ["fulfill", "fulfil"], ["enroll", "enrol"], ["toward", "towards"], ["practiced", "practised"],
    ] as const
  ).map(([us, uk]) => [new RegExp(`\\b${us}\\b`, "i"), us, uk] as const),
  [/\bgray\b/, "gray", "grey"],
  [/(?<!\bcomputer )\bprograms?\b/i, "program", "programme"],
];

/** An ask's shape: the first two words of the question itself, after any leading clause. */
export function askShapeOf(ask: string): string {
  const question = ask.includes(",") ? ask.slice(ask.lastIndexOf(",") + 1) : ask;
  return quoteWords(question).slice(0, 2).join(" ");
}

/** The last sentence of an earlier touch: its ask, as the thread carries it. */
export function askOfThreadEntry(entry: { body: string }): string {
  return sentences(entry.body).at(-1) ?? "";
}

/** How many different people a set of drafts was written for. */
export function peopleIn(drafts: readonly Pick<CohortDraft, "personId">[]): number {
  return new Set(drafts.map((draft) => draft.personId)).size;
}

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

/** A message that reads like another in the campaign: two or more people's, or a colleague's. */
function cohortAdvice(draft: MessageDraft, input: OutreachInput, cohort: readonly CohortDraft[]): Finding[] {
  if (cohort.length === 0) return [];
  const found: Finding[] = [];
  const repeated = (hits: readonly CohortDraft[]) => peopleIn(hits) >= 2 || hits.some((other) => other.sameAccount);
  const first = normalised(sentences(draft.body)[0] ?? "", input);
  if (repeated(cohort.filter((other) => jaccard(first, normalised(sentences(other.body)[0] ?? "", input)) >= 0.7))) {
    found.push({ rule: "cohort-opening", text: "It opens much like other messages in this campaign." });
  }
  const ask = normalised(draft.ask, input);
  if (repeated(cohort.filter((other) => normalised(other.ask, input) === ask))) found.push({ rule: "cohort-ask", text: "The close is the same as in other messages in this campaign." });
  const copied = sentences(draft.body)
    .map((sentence) => normalised(sentence, input))
    .filter((sentence) => sentence.split(" ").length >= 7)
    .some((mine) => repeated(cohort.filter((other) => sentences(other.body).some((theirs) => jaccard(mine, normalised(theirs, input)) >= 0.8))));
  if (copied) found.push({ rule: "cohort-sentence", text: "A sentence repeats one from another message in this campaign almost word for word." });
  return found;
}

function adviceFindings(draft: OutreachOutput, input: OutreachInput, context: GateContext): Finding[] {
  const found: Finding[] = [];
  const kind = input.touch.kind;
  const parts = proseParts(draft);
  const text = parts.join("\n");
  // A call's objection answers are the rep's reply to a brush-off: deferring a topic is how a rep moves on.
  const own = draft.kind === "call" ? callLines(draft.talkingPoint) : parts;
  const contrast = allSentences(own).find((sentence) => CONTRAST.some((pattern) => pattern.test(sentence)));
  if (contrast !== undefined) found.push({ rule: "contrast", text: `"${clip(contrast, 90)}" sets one thing against another for effect. Saying the one point plainly reads more like you.` });
  const tells = input.standard.bannedLexicon.filter((phrase) => hasTell(text, phrase));
  if (tells.length > 0) found.push({ rule: "tells", text: `It uses ${tells.map((t) => `"${t}"`).join(", ")}, which can read as a template.` });
  const spellings = US_SPELLINGS.filter(([pattern]) => pattern.test(text)).map(([, us, uk]) => `${us} (${uk})`);
  if (spellings.length > 0) found.push({ rule: "spelling", text: `American spelling: ${spellings.join(", ")}.` });
  if (text.includes("!")) found.push({ rule: "exclamation", text: "An exclamation mark rarely reads like you." });
  if (draft.kind === "message") {
    if (TIME_ASK.some((pattern) => pattern.test(`${draft.ask} ${draft.body}`))) {
      found.push({ rule: "time-ask", text: "It asks for a time or a meeting; asking whether it is of interest tends to get more replies." });
    }
    const firstName = input.person.firstName.trim();
    const greeted = /^\s*(?:hi|hello|hey|dear|morning|good morning|afternoon)\b/i.test(draft.body) || (firstName !== "" && new RegExp(`^\\s*${escape(firstName)}\\s*[,!.]`, "i").test(draft.body));
    const signsOff = /\n\s*(?:best|thanks|many thanks|cheers|regards|kind regards|best wishes)[,.!]?\s*(?:\n.*)?$/i.test(draft.body);
    // A connection note is the one touch sent as written, so "Hi Avery," there is its own first words.
    if ((greeted && kind !== "li_connect") || signsOff) found.push({ rule: "envelope", text: "The greeting and the sign-off are added for you, so the body may say them twice." });
    if (kind === "email1") {
      const subject = draft.subject?.trim() ?? "";
      const count = subject === "" ? 0 : subject.split(/\s+/).length;
      if (count < 2 || count > 4 || /quick question/i.test(subject)) found.push({ rule: "subject", text: "Subjects work best at 2 to 4 plain words." });
      if (namesProduct({ kind, body: draft.body, ask: draft.ask, claims: [...draft.claims], ...(draft.subject === undefined ? {} : { subject: draft.subject }) }, input.facts.product)) {
        found.push({ rule: "product-in-email1", text: "A first email usually lands better with no product in it, only the light line about what you've been helping with." });
      }
    }
    const shape = askShapeOf(draft.ask);
    if (shape !== "" && input.thread.some((entry) => entry.kind !== "call" && askShapeOf(askOfThreadEntry(entry)) === shape)) {
      found.push({ rule: "ask-shape", text: `An earlier touch already closes on a "${shape}…" question.` });
    }
    const cohort = kind === "email1" ? context.cohort : context.cohort.filter((other) => other.sameAccount);
    found.push(...cohortAdvice(draft, input, cohort));
  }
  if (allSentences(parts).filter((sentence) => ASIDE.test(sentence)).length > 1) found.push({ rule: "aside", text: "The line about what you've been helping with appears more than once." });
  return found;
}

// ---------------------------------------------------------------------------

/**
 * `claims` is for the product statements in the body. The model sometimes lists its opener there too, which
 * is a label and not a claim: any id that is not a product fact and is the opener's ref, a lookup item or a
 * plan item is moved out before the checks. An id that resolves to nothing stays, and `claim-id` holds it.
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

/**
 * A touch without a subject it will never be sent with. Only Email 1 opens a thread: a subject the model
 * wrote for any other touch is dropped before the checks rather than read.
 */
export function withoutThreadSubject<T extends OutreachOutput>(draft: T, kind: string): T {
  if (kind === "email1" || draft.kind !== "message" || draft.subject === undefined) return draft;
  const rest: MessageDraft = { ...draft };
  delete rest.subject;
  return rest as T;
}

/** Every check on a touch: the eight truth checks (Tier A) and the style advice (Tier B). */
export function gateFor(draft: OutreachOutput, input: OutreachInput, context: GateContext): GateResult {
  const kind = input.touch.kind;
  if ((draft.kind === "call") !== (kind === "call")) {
    return { tierA: [{ rule: "kind", text: kind === "call" ? "A call script is a talking point, not a message." : "This touch is a message, not a call script." }], tierB: [] };
  }
  const parts = proseParts(draft);
  const text = parts.join("\n");
  const tierA: Finding[] = [];

  // 8: length, and a call script that is missing a part.
  tierA.push(...checkTouchLimits(draft, input));
  if (draft.kind === "call") {
    if (draft.talkingPoint.voicemail === undefined) tierA.push({ rule: "voicemail", text: "The call script has no voicemail." });
    if (draft.talkingPoint.openingLine2 === undefined || draft.talkingPoint.oneQuestion2 === undefined) {
      tierA.push({ rule: "second-call", text: "The script has nothing for the second call: it needs its own opener and its own question." });
    }
  }
  // 1: price.
  tierA.push(...priceFindings(draft, input));
  // 2: product claims beyond the facts file's own words (claim-id and claim-number are in `checkTouchLimits`).
  if (context.neverSay !== undefined) {
    const issues = neverSayIssues(parts.map((part, index) => ({ where: `part ${index + 1}`, text: part })), context.neverSay);
    if (issues.length > 0) tierA.push({ rule: "never-say", text: `It says something the product's own facts forbid: ${issues.map((issue) => issue.replace(/^part \d+: /, "")).join("; ")}` });
  }
  // 3: evidence.
  const about = [input.person.company, input.account.company, input.person.name];
  const names = allowedValues(input, context);
  for (const sentence of unsupportedSourceClaims(parts, input.pack.evidence, about, names)) {
    tierA.push({ rule: "unsupported-source-claim", text: sourceClaimFix(sentence, closestQuote(sentence, input.pack.evidence)) });
  }
  // 4: invented experience.
  tierA.push(...inventedFindings(parts));
  // 5: names, numbers and the firm's line of business.
  const provenance = parts.flatMap((part) => provenanceFindings(part, input, context));
  tierA.push(...provenance.filter((finding, index) => provenance.findIndex((other) => other.rule === finding.rule && other.text === finding.text) === index));
  tierA.push(...firmLineFindings(parts, input));
  // 6: colleagues.
  tierA.push(...colleagueFindings(draft, input, context));
  // 7: links and gender guesses.
  if (/https?:\/\/|www\.[a-z]/i.test(text)) tierA.push({ rule: "link", text: "It carries a link. Nothing Relay drafts carries one." });
  const pronouns = [...new Set(genderedPronouns({ kind, body: text, ask: "", claims: [] }))];
  if (pronouns.length > 0) tierA.push({ rule: "gendered-pronoun", text: `It says ${pronouns.map((word) => `"${word}"`).join(", ")} about the prospect. Use their name or "they".` });

  return { tierA, tierB: adviceFindings(draft, input, context) };
}
