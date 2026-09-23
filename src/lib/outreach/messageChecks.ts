/**
 * Messaging v2 (22 Sep 2026): the measures the cohort report puts against the
 * writing standard, and the humanizer's change size the draft job records.
 *
 * These are **report measures, not gates.** They read the words a rep would see
 * and count what the standard forbids or asks for: the product in Email 1, a
 * price in a cold touch, "X, or Y?" asks, stock openers and subjects, gendered
 * pronouns, an attributed insight, and how much of a touch the humanizer
 * changed. Some are heuristics (the product sentence and the attributed
 * insight read patterns in the text) and the report says so. M2 turns the
 * reliable ones into gates.
 */

/** A written touch as the checks read it: what the rep sees, and the fact ids it cites. */
export type CheckedTouch = {
  kind: string;
  subject?: string;
  /** A message's body, or a call script as its labelled lines. */
  body: string;
  ask: string;
  claims: string[];
  /** The humanizer's change to this touch, as a percentage of characters; null when it returned nothing for it. */
  changePct?: number | null;
};

export type CheckedSequence = { name: string; touches: CheckedTouch[] };

/** One person's stored drafts, with the change sizes the `outreach.drafted` Event recorded. Drafts never written are left out. */
export function checkedSequenceOf(
  name: string,
  drafts: readonly { touch: string; subject: string | null; body: string | null; ask: string | null; claims: unknown }[],
  humanizer: Record<string, { changePct?: number | null } | undefined>,
): CheckedSequence {
  const touches = drafts.flatMap((draft): CheckedTouch[] =>
    draft.body === null
      ? []
      : [
          {
            kind: draft.touch,
            ...(draft.subject === null ? {} : { subject: draft.subject }),
            body: draft.body,
            ask: draft.ask ?? "",
            claims: Array.isArray(draft.claims) ? draft.claims.filter((claim): claim is string => typeof claim === "string") : [],
            changePct: humanizer[draft.touch]?.changePct ?? null,
          },
        ],
  );
  return { name, touches };
}

/** The touches that are emails, and the LinkedIn messages; the connection note and the call are neither. */
export const EMAIL_TOUCHES = ["email1", "email2", "breakup"] as const;
export const MESSAGE_TOUCHES = ["email1", "email2", "breakup", "li_dm", "li_dm2"] as const;
/** Every touch a prospect reads cold: the emails and all three LinkedIn touches. The call script is the rep's. */
export const COLD_TOUCHES = ["email1", "email2", "breakup", "li_connect", "li_dm", "li_dm2"] as const;

const includes = (list: readonly string[], kind: string) => list.includes(kind);

/**
 * Characters changed between two texts, as a percentage of the longer one:
 * the edit (Levenshtein) distance over characters. 0 is untouched; 100 is
 * nothing in common.
 */
export function changePct(before: string, after: string): number {
  if (before === after) return 0;
  const longer = Math.max(before.length, after.length);
  if (longer === 0) return 0;
  let previous = Array.from({ length: after.length + 1 }, (_, index) => index);
  for (let i = 1; i <= before.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= after.length; j += 1) {
      const cost = before[i - 1] === after[j - 1] ? 0 : 1;
      current[j] = Math.min(previous[j]! + 1, current[j - 1]! + 1, previous[j - 1]! + cost);
    }
    previous = current;
  }
  return Math.round((previous[after.length]! / longer) * 1000) / 10;
}

/** A touch's prose as one string, for measuring change: the subject, the body, or the call script's fields in order. */
export function proseString(prose: {
  subject?: string;
  body?: string;
  openingLine?: string;
  oneQuestion?: string;
  listenFor?: string;
  voicemail?: string;
  objections?: { objection: string; answer: string }[];
}): string {
  if (prose.body !== undefined) return [prose.subject, prose.body].filter((part) => part !== undefined).join("\n\n");
  return [prose.openingLine, prose.oneQuestion, prose.listenFor, prose.voicemail, ...(prose.objections ?? []).flatMap((pair) => [pair.objection, pair.answer])]
    .filter((part) => part !== undefined)
    .join("\n\n");
}

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A first-person or tool sentence about what the product does (heuristic). */
const PRODUCT_SENTENCE =
  /\b(?:we|our (?:tool|product|platform|software|system|service))\s+(?:now\s+)?(?:score|scores|check|checks|transcribe|transcribes|analyse|analyses|read|reads|review|reviews|flag|flags|build|built|help|helps|pull|pulls|search|searches)\b|\bevery (?:analysed |recorded |ingested )?call (?:that comes in|you take|gets transcribed)\b/i;

/** The product named, a product sentence, or a cited fact. */
export function mentionsProduct(touch: CheckedTouch, product: string): boolean {
  if (touch.claims.length > 0) return true;
  const text = `${touch.subject ?? ""}\n${touch.body}`;
  if (product.trim() !== "" && new RegExp(`(^|[^a-z0-9])${escape(product.toLowerCase())}($|[^a-z0-9])`).test(text.toLowerCase())) return true;
  return PRODUCT_SENTENCE.test(text);
}

const PRICE = /£\s?\d|\bgbp\s?\d|\bper seat\b|\bset-?up fee\b|\bmonth to month\b|\bseat minimum\b|\block-in\b|\bannual (?:commitment|contract)\b|\bpric(?:e|es|ed|ing)\b|\bconfiguration review\b/i;

/** A price, fee or contract term, or a cited price fact. */
export function mentionsPrice(touch: CheckedTouch): boolean {
  return touch.claims.some((claim) => claim.startsWith("i360.price.")) || PRICE.test(`${touch.subject ?? ""}\n${touch.body}`);
}

/** An "X, or Y?" ask: a question that ends by offering the reader two answers. */
export function isBinaryAsk(ask: string): boolean {
  return /(?:,\s*or\b[^?]*|\bor not)\?\s*$/i.test(ask.trim());
}

const STOCK_OPENERS: readonly RegExp[] = [
  /^(?:thanks|thank you|many thanks) for (?:connecting|accepting|the connection)/i,
  /^(?:good|great|nice) to (?:be )?connect/i,
  /^one (?:more|last|final) (?:thought|thing|note|point)/i,
  /^(?:just )?(?:following up|checking in|circling back|bumping this)/i,
  /^(?:i )?hope (?:this|you|all)/i,
  /^quick question/i,
];
const STOCK_SUBJECTS = /^(?:one last note|last note|quick question|following up|just following up|checking in|just checking in|touching base|one more thing|one more thought|before i go|before i stop)$/i;

/** The stock opener or subject this touch uses, if any. */
export function stockOpener(touch: CheckedTouch): string | null {
  if (touch.subject !== undefined && STOCK_SUBJECTS.test(touch.subject.trim().replace(/[.?!]+$/, ""))) return `subject "${touch.subject.trim()}"`;
  // A call script's first line is its label and a greeting; the opener is what follows them.
  const opening = touch.body
    .trim()
    .replace(/^Open with:\s*/i, "")
    .replace(/^(?:hi|hello)\b[^,.]*[,.]\s*/i, "");
  const found = STOCK_OPENERS.find((pattern) => pattern.test(opening));
  return found === undefined ? null : `opener "${(opening.match(/^[^.?!,:]*/)?.[0] ?? opening).slice(0, 40)}"`;
}

const PRONOUNS = /\b(?:he|him|his|she|her|hers|himself|herself)\b/gi;

/** The gendered pronouns in a touch, lower case. */
export function genderedPronouns(touch: CheckedTouch): string[] {
  return [...`${touch.subject ?? ""}\n${touch.body}`.matchAll(PRONOUNS)].map((match) => match[0].toLowerCase());
}

const SOURCE = /\b(?:ombudsman|fca|financial conduct authority|regulator|which\?|consumer duty|survey|study|research|report|publication|figures|data|tables?)\b/i;
// No bare "report" here: it is a source word above, and one word must not count as both halves.
const REPORTING = /\b(?:found|finds|show|shows|showed|shown|said|says|publishes|published|reported|rose|fell|up from|down from|according to|reviewed)\b/i;
const PERSONAL = /\byou (?:said|wrote|told|posted|mentioned|shared)\b|\byour (?:post|talk|article|comment|publication|interview|conference)\b|'s (?:\w+ )?(?:publication|report|results|figures|announcement)\b/i;

/** An attributed insight: a named source and what it found, or the reader's own public words (heuristic). */
export function hasAttributedInsight(touch: CheckedTouch): boolean {
  return (SOURCE.test(touch.body) && REPORTING.test(touch.body)) || PERSONAL.test(touch.body);
}

export function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

/** The standard's measures over a set of sequences, for the report and the comparison. */
export type CohortMeasures = {
  people: number;
  touches: number;
  productInEmail1: number;
  email1s: number;
  /** Written touches (not the call) that name, describe or cite the product, most in any one sequence. */
  maxProductPerSequence: number;
  priceInColdTouch: number;
  coldTouches: number;
  binaryAsks: number;
  maxBinaryPerSequence: number;
  stockOpeners: number;
  genderedTouches: number;
  withInsight: number;
  messages: number;
  /** Median over the touches the humanizer returned text for; null when none carry a change size. */
  medianChangePct: number | null;
  changed: number;
};

export function measure(sequences: readonly CheckedSequence[], product: string): CohortMeasures {
  const all = sequences.flatMap((sequence) => sequence.touches);
  const cold = all.filter((touch) => includes(COLD_TOUCHES, touch.kind));
  const messages = all.filter((touch) => includes(MESSAGE_TOUCHES, touch.kind));
  const email1s = all.filter((touch) => touch.kind === "email1");
  const changes = all.flatMap((touch) => (typeof touch.changePct === "number" ? [touch.changePct] : []));
  const perSequence = (count: (touch: CheckedTouch) => boolean, among: readonly string[]) =>
    Math.max(0, ...sequences.map((sequence) => sequence.touches.filter((touch) => includes(among, touch.kind) && count(touch)).length));
  return {
    people: sequences.length,
    touches: all.length,
    productInEmail1: email1s.filter((touch) => mentionsProduct(touch, product)).length,
    email1s: email1s.length,
    maxProductPerSequence: perSequence((touch) => mentionsProduct(touch, product), COLD_TOUCHES),
    priceInColdTouch: cold.filter(mentionsPrice).length,
    coldTouches: cold.length,
    binaryAsks: all.filter((touch) => isBinaryAsk(touch.ask)).length,
    maxBinaryPerSequence: perSequence((touch) => isBinaryAsk(touch.ask), [...COLD_TOUCHES, "call"]),
    stockOpeners: all.filter((touch) => stockOpener(touch) !== null).length,
    genderedTouches: all.filter((touch) => genderedPronouns(touch).length > 0).length,
    withInsight: messages.filter(hasAttributedInsight).length,
    messages: messages.length,
    medianChangePct: changes.length === 0 ? null : median(changes),
    changed: changes.length,
  };
}

const TOUCH_NAME: Record<string, string> = {
  email1: "Email 1",
  email2: "Email 2 (follow-up)",
  breakup: "Email 3 (last email)",
  li_connect: "LinkedIn connection note",
  li_dm: "LinkedIn message",
  li_dm2: "LinkedIn follow-up",
  call: "Call script",
};
const ORDER = ["email1", "email2", "breakup", "li_connect", "li_dm", "li_dm2", "call"];

const pct = (value: number | null) => (value === null ? "n/a" : `${value.toFixed(1)}%`);
const mark = (ok: boolean) => (ok ? "yes" : "**no**");

/** The report's messaging v2 section: per touch kind, per person, and the acceptance bar. */
export function renderChecks(sequences: readonly CheckedSequence[], product: string): string {
  const kindRows = ORDER.flatMap((kind) => {
    const own = sequences.flatMap((sequence) => sequence.touches.filter((touch) => touch.kind === kind));
    if (own.length === 0) return [];
    const count = (test: (touch: CheckedTouch) => boolean) => own.filter(test).length;
    const changes = own.flatMap((touch) => (typeof touch.changePct === "number" ? [touch.changePct] : []));
    const insight = includes(MESSAGE_TOUCHES, kind) ? `${count(hasAttributedInsight)} of ${own.length}` : "n/a";
    const price = includes(COLD_TOUCHES, kind) ? String(count(mentionsPrice)) : `${count(mentionsPrice)} (allowed)`;
    return [
      `| ${TOUCH_NAME[kind] ?? kind} | ${own.length} | ${count((touch) => mentionsProduct(touch, product))} | ${price} | ${count((touch) => isBinaryAsk(touch.ask))} | ${count((touch) => stockOpener(touch) !== null)} | ${count((touch) => genderedPronouns(touch).length > 0)} | ${insight} | ${pct(changes.length === 0 ? null : median(changes))} |`,
    ];
  });
  const personRows = sequences.map((sequence) => {
    const one = measure([sequence], product);
    const stock = sequence.touches.flatMap((touch) => {
      const found = stockOpener(touch);
      return found === null ? [] : [`${touch.kind}: ${found}`];
    });
    const pronouns = [...new Set(sequence.touches.flatMap(genderedPronouns))];
    return `| ${sequence.name} | ${one.productInEmail1 > 0 ? "**yes**" : "no"} | ${one.maxProductPerSequence} | ${one.priceInColdTouch} | ${one.binaryAsks} | ${stock.join("; ") || "none"} | ${pronouns.join(", ") || "none"} | ${one.withInsight} of ${one.messages} | ${pct(one.medianChangePct)} |`;
  });
  const total = measure(sequences, product);
  return [
    "## Messaging v2 checks",
    "",
    'Counted by `src/lib/outreach/messageChecks.ts` over the words the rep sees. "Product" is the product named, a first-person product sentence or a cited fact, and "attributed insight" is a named source with what it found, or the reader\'s own public words: both are **heuristics**, so read the text before trusting a count. The humanizer change is the share of characters it changed, over the touches it returned text for.',
    "",
    "### Per touch kind",
    "",
    '| Touch | Written | Product named or described | Price | "X, or Y?" asks | Stock opener or subject | Gendered pronouns | Attributed insight | Humanizer change (median) |',
    "|---|---|---|---|---|---|---|---|---|",
    ...kindRows,
    "",
    "### Per person",
    "",
    '| Person | Product in Email 1 | Written touches with the product | Price in cold touches | "X, or Y?" asks | Stock openers or subjects | Gendered pronouns | Emails and LinkedIn messages with an insight | Humanizer change (median) |',
    "|---|---|---|---|---|---|---|---|---|",
    ...personRows,
    "",
    "### Against the acceptance bar",
    "",
    "| Measure | Bar | This run | Met |",
    "|---|---|---|---|",
    `| Product lines in Email 1 | 0 | ${total.productInEmail1} of ${total.email1s} | ${mark(total.productInEmail1 === 0)} |`,
    `| Price in a cold touch | 0 | ${total.priceInColdTouch} of ${total.coldTouches} | ${mark(total.priceInColdTouch === 0)} |`,
    `| "X, or Y?" asks in any one sequence | at most 1 | at most ${total.maxBinaryPerSequence} (${total.binaryAsks} in total) | ${mark(total.maxBinaryPerSequence <= 1)} |`,
    `| Stock openers or subjects | 0 | ${total.stockOpeners} | ${mark(total.stockOpeners === 0)} |`,
    `| Touches with a gendered pronoun | 0 | ${total.genderedTouches} | ${mark(total.genderedTouches === 0)} |`,
    `| Humanizer change, median | at least 10% | ${pct(total.medianChangePct)} over ${total.changed} touches | ${mark(total.medianChangePct !== null && total.medianChangePct >= 10)} |`,
    `| Emails and LinkedIn messages with an attributed insight | reported, no bar | ${total.withInsight} of ${total.messages} | n/a |`,
    "",
  ].join("\n");
}

/** The same measures side by side: an earlier cohort and this run. */
export function renderComparison(before: readonly CheckedSequence[], now: readonly CheckedSequence[], product: string, beforeLabel: string): string {
  const a = measure(before, product);
  const b = measure(now, product);
  const row = (label: string, left: string, right: string) => `| ${label} | ${left} | ${right} |`;
  return [
    `## Compared with ${beforeLabel}`,
    "",
    "The earlier report parsed with the same measures, over the text the rep saw there (the humanized text, or the draft where the humanized version was not kept). The people are the same fixture people; the prompt, standard and humanizer are not.",
    "",
    `| Measure | ${beforeLabel} | This run |`,
    "|---|---|---|",
    row("People", String(a.people), String(b.people)),
    row("Touches written", String(a.touches), String(b.touches)),
    row("Product in Email 1", `${a.productInEmail1} of ${a.email1s}`, `${b.productInEmail1} of ${b.email1s}`),
    row("Most written touches with the product, in one sequence", String(a.maxProductPerSequence), String(b.maxProductPerSequence)),
    row("Price in a cold touch", `${a.priceInColdTouch} of ${a.coldTouches}`, `${b.priceInColdTouch} of ${b.coldTouches}`),
    row('"X, or Y?" asks (most in one sequence)', `${a.binaryAsks} (${a.maxBinaryPerSequence})`, `${b.binaryAsks} (${b.maxBinaryPerSequence})`),
    row("Stock openers or subjects", String(a.stockOpeners), String(b.stockOpeners)),
    row("Touches with a gendered pronoun", String(a.genderedTouches), String(b.genderedTouches)),
    row("Emails and LinkedIn messages with an attributed insight", `${a.withInsight} of ${a.messages}`, `${b.withInsight} of ${b.messages}`),
    row("Humanizer change, median", `${pct(a.medianChangePct)} (${a.changed} touches)`, `${pct(b.medianChangePct)} (${b.changed} touches)`),
    "",
  ].join("\n");
}

const NAME_TO_KIND = Object.fromEntries(Object.entries(TOUCH_NAME).map(([kind, name]) => [name, kind]));

/**
 * An earlier `cohort.md` read back into sequences: each person's touches, the
 * text the rep saw (the humanized block, or the drafted one where the draft was
 * kept), the stored ask and claims, and the humanizer's change from the two
 * blocks. Touches that were never written are left out.
 */
export function parseCohortMarkdown(markdown: string): CheckedSequence[] {
  const people = markdown.split(/^## /m).slice(1).filter((section) => / · role: /.test(section.split("\n")[0] ?? ""));
  return people.map((section) => {
    const name = (section.split("\n")[0] ?? "").split(" · ")[0]!.trim();
    const touches = section
      .split(/^### /m)
      .slice(1)
      .flatMap((block): CheckedTouch[] => {
        const heading = block.split("\n")[0] ?? "";
        const kind = NAME_TO_KIND[heading.split(" · ")[0]!.trim()];
        if (kind === undefined) return [];
        const fenced = [...block.matchAll(/```\n([\s\S]*?)\n```/g)].map((match) => match[1]!);
        const drafted = fenced[0];
        const humanized = fenced[1];
        if (drafted === undefined || drafted === "(not written)") return [];
        const keptDraft = /kept: drafted/.test(heading) || humanized === undefined || /^\((?:none|no humanizer pass)/.test(humanized);
        const text = keptDraft ? drafted : humanized!;
        const subject = text.match(/^Subject: (.*)$/m)?.[1];
        const body = subject === undefined ? text : text.replace(/^Subject: .*\n\n?/, "");
        const ask = block.match(/ask "([^"]*)"/)?.[1] ?? "";
        const claims = (() => {
          const raw = block.match(/\*\*Claims:\*\* `([^`]*)`/)?.[1];
          try {
            return raw === undefined ? [] : (JSON.parse(raw) as string[]);
          } catch {
            return [];
          }
        })();
        const changed = humanized === undefined || /^\((?:none|no humanizer pass)/.test(humanized) ? null : changePct(drafted, humanized);
        return [{ kind, ...(subject === undefined ? {} : { subject }), body, ask, claims, changePct: changed }];
      });
    // A person with no touch read back is a report this parser does not understand, not a person with nothing written.
    if (touches.length === 0) console.warn(`cohort --compare: no touches read for ${name}; is the earlier report in the expected shape?`);
    return { name, touches };
  });
}
