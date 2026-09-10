/**
 * The injection scan on fetched text (research v2 §4).
 *
 * A fetched page is untrusted input that the model will read as data. A line
 * on it that is shaped like an instruction — to an assistant, to "the AI", to
 * ignore what came before — is stripped before the text is stored or shown to
 * the model, and the count is recorded on the tool step so a page that carried
 * many is visible in the run. Applied before the size cap, so the record, the
 * corpus and the model all see one text.
 *
 * Line-level and conservative: the aim is to remove the obvious shapes, not to
 * prove a page clean. A missed line reaches a model whose only tools are
 * read-only and whose output is validated against a schema and a corpus.
 */

const PATTERNS: RegExp[] = [
  /\bignore\s+(all\s+|the\s+|any\s+)?(previous|prior|above|earlier|preceding)\b/i,
  /\bdisregard\s+(all\s+|the\s+|any\s+)?(previous|prior|above|earlier)\b/i,
  /\byou\s+are\s+(now\s+)?(an?\s+|the\s+)?(ai|assistant|model|agent|llm|language model|chatbot)\b/i,
  /^\s*(system|assistant|user|human|developer)\s*:/i,
  /<\|(im_start|im_end|system|endoftext)\|>/i,
  /\[\s*\/?(INST|SYS|SYSTEM)\s*\]/i,
  /\b(do\s+not|don't|never)\s+(tell|inform|reveal\s+to)\s+the\s+user\b/i,
  /\b(to|for)\s+(any|all|the)\s+(ai|assistant|llm|language model|agent)s?\s+(reading|processing|parsing)\b/i,
  /\bprompt\s+injection\b.*\b(execute|run|follow)\b/i,
  /^\s*(important|note|attention)\s*(to|for)\s+(ai|assistants?|llms?|agents?|models?)\b/i,
  /\b(as|when)\s+an?\s+(ai|assistant|llm)\b.*\b(you\s+must|you\s+should|always|never)\b/i,
];

export type ScrubResult = { text: string; stripped: string[] };

export function scrubFetched(markdown: string): ScrubResult {
  const kept: string[] = [];
  const stripped: string[] = [];
  for (const line of markdown.split(/\r?\n/)) {
    if (PATTERNS.some((pattern) => pattern.test(line))) {
      stripped.push(line.length > 200 ? `${line.slice(0, 199)}…` : line);
      continue;
    }
    kept.push(line);
  }
  return { text: kept.join("\n"), stripped };
}

/** The size cap on a fetched page (research v2 §4: "12k cap"). */
export const FETCH_CHAR_CAP = 8_000;

export function capText(text: string, cap: number = FETCH_CHAR_CAP): string {
  return text.length <= cap ? text : `${text.slice(0, cap)}\n\n[truncated at ${cap} characters]`;
}
