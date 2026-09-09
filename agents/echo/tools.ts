import { createHash } from "node:crypto";

import { tool } from "ai";
import { z } from "zod";

import { withReplay, type ToolRecorder } from "@/lib/agents/tools";

/**
 * Echo's one tool.
 *
 * It does nothing a machine could not do inline, which is deliberate: the thing
 * under test is the wrapper, not the work. `shout` is here so that a run has a
 * `tool` step with an input, an output and a replay key, and so that the replay
 * test can count how many times the body actually ran.
 */

const shoutArgs = z.object({ text: z.string().min(1).max(500) });
const shoutResult = z.object({ text: z.string() }).strict();

export type ShoutArgs = z.infer<typeof shoutArgs>;

/**
 * Build the tool set for one run.
 *
 * `onRun` is the counter the replay test reads: a replayed call never reaches
 * the body, so "the tool executed zero times" is an observation rather than an
 * inference from the step table.
 */
export function echoTools(recorder: ToolRecorder, onRun?: (args: ShoutArgs) => void) {
  return {
    shout: tool({
      description: "Return the given text in upper case.",
      inputSchema: shoutArgs,
      execute: withReplay(recorder, {
        name: "shout",
        // The text itself, hashed: the key has to be bounded, and a 500
        // character argument in a key column is a log, not a key.
        toolKey: (args) => createHash("sha256").update(args.text).digest("hex"),
        // Given, so a replayed payload is parsed rather than asserted: a replay
        // comes out of a Json column written by an earlier deploy, and
        // `output as OUT` would be a claim about a row on disk.
        output: shoutResult,
        execute: async (args) => {
          onRun?.(args);
          return { text: args.text.toUpperCase() };
        },
      }),
    }),
  };
}

/** The tool names echo declares. Asserted against the definition by `runAgent`. */
export const ECHO_TOOL_NAMES = ["shout"] as const;
