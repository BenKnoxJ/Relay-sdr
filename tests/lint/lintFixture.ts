import path from "node:path";

import { ESLint } from "eslint";

const projectRoot = path.resolve(import.meta.dirname, "..", "..");

// One instance for the whole suite: constructing ESLint loads and resolves the
// full flat config (Next's shareable configs included), which is the expensive
// part. Linting a string after that is cheap.
let shared: ESLint | undefined;

function eslint(): ESLint {
  shared ??= new ESLint({ cwd: projectRoot });
  return shared;
}

export type Finding = { ruleId: string | null; message: string; line: number };

/**
 * Lint `code` as if it were the file at `relativePath` (which need not exist)
 * and return the findings. The path is what selects the config block, so it is
 * the point of these tests: the same source is legal in one directory and
 * banned in another.
 */
export async function lintFixture(relativePath: string, code: string): Promise<Finding[]> {
  const results = await eslint().lintText(code, {
    filePath: path.join(projectRoot, relativePath),
    warnIgnored: false,
  });

  return results.flatMap((result) =>
    result.messages.map((message) => ({
      ruleId: message.ruleId,
      message: message.message,
      line: message.line,
    })),
  );
}

export function findingsFor(findings: Finding[], ruleId: string): Finding[] {
  return findings.filter((finding) => finding.ruleId === ruleId);
}
