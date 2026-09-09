import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * Recorded provider responses, on disk.
 *
 * `<dir>/<tool>/<discriminator>.json` holds `{ tool, args, response,
 * recordedAt }`. Written by a live service in record mode, read by the mock.
 * The bench and the rubric point `RELAY_TOOL_FIXTURES` at one brief's
 * subdirectory (`fixtures/tools/research/<brief>`), so a brief replays only
 * what it recorded.
 */

export type Recording<A, R> = { tool: string; args: A; response: R; recordedAt: string };

export function recordingPath(dir: string, tool: string, discriminator: string): string {
  if (!/^[0-9a-f]{64}$/.test(discriminator)) throw new Error(`recordings: ${JSON.stringify(discriminator)} is not a discriminator`);
  return path.join(dir, tool, `${discriminator}.json`);
}

export function readRecording<A, R>(dir: string, tool: string, discriminator: string): Recording<A, R> | null {
  const file = recordingPath(dir, tool, discriminator);
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, "utf8")) as Recording<A, R>;
}

export function writeRecording<A, R>(dir: string, tool: string, discriminator: string, recording: Omit<Recording<A, R>, "recordedAt">): string {
  const file = recordingPath(dir, tool, discriminator);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify({ ...recording, recordedAt: new Date().toISOString() }, null, 2)}\n`);
  return file;
}
