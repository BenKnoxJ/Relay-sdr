import type { OutreachInput } from "../../../agents/outreach/input.schema";
import { checkTouchLimits, type MessageDraft, type OutreachOutput } from "../../../agents/outreach/output.schema";

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

/** A draft already written in this campaign, as the cohort gates read it. */
export type CohortDraft = { body: string; ask: string; sameAccount: boolean };

export type GateContext = {
  /** The product's name as the rep says it; always allowed in a body. */
  productNames: readonly string[];
  /** The rep's own name. */
  repName: string;
  /** The campaign's other drafts, newest first. */
  cohort: readonly CohortDraft[];
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

function shapeFindings(draft: MessageDraft, input: OutreachInput, lexicon: readonly string[]): Finding[] {
  const found: Finding[] = [];
  const body = draft.body;
  const count = sentences(body).length;
  if (count < 3 || count > 5) found.push({ rule: "sentences", text: `This is ${count} sentence${count === 1 ? "" : "s"}; a first email is 3 to 5.` });
  if (paragraphs(body).some((p) => sentences(p).length > 3)) found.push({ rule: "paragraphs", text: "A paragraph runs past three sentences; break it up for a phone screen." });
  if (/https?:\/\/|www\.[a-z]/i.test(body)) found.push({ rule: "link", text: "A first email carries no link." });
  if (body.includes("!") || (draft.subject ?? "").includes("!")) found.push({ rule: "exclamation", text: "No exclamation marks." });
  const askLike = `${draft.ask} ${body}`;
  if (TIME_ASK.some((pattern) => pattern.test(askLike))) {
    found.push({ rule: "time-ask", text: "It asks for a time, a meeting length or a calendar slot; ask whether it is relevant instead." });
  }
  if (ANTITHESIS.some((pattern) => pattern.test(body))) found.push({ rule: "antithesis", text: "It uses the \"it isn't X, it's Y\" turn; say the point plainly." });
  const tells = lexicon.filter((phrase) => hasPhrase(`${draft.subject ?? ""} ${body}`, phrase));
  if (tells.length > 0) found.push({ rule: "tells", text: `It uses ${tells.map((t) => `"${t}"`).join(", ")}, which reads as a template.` });
  const us = US_SPELLINGS.filter((word) => new RegExp(`\\b${word}\\b`, "i").test(body));
  if (us.length > 0) found.push({ rule: "spelling", text: `American spelling: ${us.join(", ")}. Use British English.` });
  // v2.1 §2: the greeting and the sign-off are Relay's envelope; the body is what sits between them.
  const first = input.person.firstName.trim();
  const opensWithName = first !== "" && new RegExp(`^\\s*${escape(first)}\\s*[,!.]`, "i").test(body);
  const signsOff = /\n\s*(?:best|thanks|many thanks|cheers|regards|kind regards|best wishes)[,.!]?\s*(?:\n.*)?$/i.test(body);
  if (/^\s*(?:hi|hello|hey|dear|morning|good morning|afternoon)\b/i.test(body) || opensWithName || signsOff) {
    found.push({ rule: "envelope", text: "Relay adds the greeting and the sign-off; the body starts with the first sentence and ends with the question." });
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

/** The words the input already carries, which a body may always use. */
function allowedWords(input: OutreachInput, context: GateContext): Set<string> {
  const values = [
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
  ];
  return new Set(values.flatMap((value) => words(value)));
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
    const tokens = words(entity).filter((token) => !ORDINARY.has(token) && !CALENDAR.has(token) && !allowed.has(token));
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

function cohortFindings(draft: MessageDraft, input: OutreachInput, cohort: readonly CohortDraft[]): { tierA: Finding[]; tierB: Finding[] } {
  const tierA: Finding[] = [];
  const tierB: Finding[] = [];
  if (cohort.length === 0) return { tierA, tierB };

  // Opening frame: near-identical to two or more drafts, or to any at the same account.
  const mine = frame(draft.body, input);
  const firstSentence = normalised(sentences(draft.body)[0] ?? "", input);
  const sameFrame = cohort.filter((other) => {
    const theirs = frame(other.body, input);
    return (mine !== "" && mine === theirs) || jaccard(firstSentence, normalised(sentences(other.body)[0] ?? "", input)) >= 0.7;
  });
  if (sameFrame.length >= 2 || sameFrame.some((other) => other.sameAccount)) {
    tierA.push({ rule: "cohort-opening", text: "It opens the same way as other emails in this campaign; open on this person's own reason." });
  }

  // The ask: identical after normalising to one already used twice, or once at the same account.
  const ask = normalised(draft.ask, input);
  const sameAsk = cohort.filter((other) => normalised(other.ask, input) === ask);
  if (sameAsk.length >= 2 || sameAsk.some((other) => other.sameAccount)) {
    tierA.push({ rule: "cohort-ask", text: "The question at the end is the same as in other emails in this campaign; ask it this person's way." });
  }

  // A distinctive sentence near-identical to one in two or more drafts, or one at the same account.
  const repeated = sentences(draft.body)
    .map((sentence) => normalised(sentence, input))
    .filter((sentence) => sentence.split(" ").length >= 7)
    .find((sentence) => {
      const hits = cohort.filter((other) => sentences(other.body).some((theirs) => jaccard(sentence, normalised(theirs, input)) >= 0.8));
      return hits.length >= 2 || hits.some((other) => other.sameAccount);
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
  const tierA = [
    ...checkTouchLimits(draft, input),
    ...shapeFindings(draft, input, input.standard.bannedLexicon),
    ...provenance.tierA,
    ...cohort.tierA,
  ];
  return { tierA, tierB: [...adviceFindings(draft), ...provenance.tierB, ...cohort.tierB] };
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
  return [point.openingLine, point.oneQuestion, point.listenFor, point.voicemail ?? "", ...(point.objections ?? []).flatMap((pair) => [pair.objection, pair.answer])].filter((part) => part !== "");
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
    if (/^\s*(?:hi|hello|hey|dear|morning|good morning|afternoon)\b/i.test(draft.body) || opensWithName || signsOff) {
      found.push({ rule: "envelope", text: "Relay adds the greeting and the sign-off; the message starts with the first sentence and ends with the question." });
    }
  } else if (draft.talkingPoint.voicemail === undefined) {
    found.push({ rule: "voicemail", text: "The call script has no voicemail." });
  }
  if (ANTITHESIS.some((pattern) => pattern.test(text))) found.push({ rule: "antithesis", text: "It uses the \"it isn't X, it's Y\" turn; say the point plainly." });
  const tells = input.standard.bannedLexicon.filter((phrase) => hasPhrase(text, phrase));
  if (tells.length > 0) found.push({ rule: "tells", text: `It uses ${tells.map((t) => `"${t}"`).join(", ")}, which reads as a template.` });
  const us = US_SPELLINGS.filter((word) => new RegExp(`\\b${word}\\b`, "i").test(text));
  if (us.length > 0) found.push({ rule: "spelling", text: `American spelling: ${us.join(", ")}. Use British English.` });
  // Provenance part by part, one finding per rule and text.
  const checked = proseParts(draft).map((part) => provenanceFindings(part, input, context));
  const unique = (list: Finding[]) => list.filter((finding, index) => list.findIndex((other) => other.rule === finding.rule && other.text === finding.text) === index);
  const provenance = { tierA: unique(checked.flatMap((result) => result.tierA)), tierB: unique(checked.flatMap((result) => result.tierB)) };
  const advice = draft.kind === "message" ? adviceFindings(draft).filter((finding) => finding.rule !== "subject") : [];
  return { tierA: [...found, ...provenance.tierA], tierB: [...advice, ...provenance.tierB] };
}

/** The gate for a touch, chosen by its kind: Email 1 keeps its own. */
export function gateFor(draft: OutreachOutput, input: OutreachInput, context: GateContext): GateResult {
  return input.touch.kind === "email1" ? gateEmail1(draft, input, context) : gateTouch(draft, input, context);
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
