#!/usr/bin/env node
// Blocking dependency audit.
//
// `npm audit --audit-level=high` fails the moment anything high or critical
// appears, which is why the scaffold ran it with `continue-on-error` and
// therefore ran it for nothing. This wrapper keeps the gate blocking and moves
// the judgement into a reviewed file: an advisory is either fixed or it is
// written down in .audit-allowlist.json with a reason and an expiry date.
//
// Exit codes: 0 clean, 1 an advisory is not allow-listed (or its entry has
// expired), 2 the check itself could not run.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const ROOT = path.resolve(import.meta.dirname, "..");
const ALLOWLIST = path.join(ROOT, ".audit-allowlist.json");

// Runtime dependencies only. Dev-tree advisories are real but they are not
// reachable from a request, and holding the deploy gate on them would make the
// gate something people route around.
const AUDIT_ARGS = ["audit", "--omit=dev", "--json"];
const BLOCKING = new Set(["high", "critical"]);

function fail(code, message) {
  console.error(message);
  process.exit(code);
}

const result = spawnSync("npm", AUDIT_ARGS, {
  cwd: ROOT,
  encoding: "utf8",
  maxBuffer: 64 * 1024 * 1024,
});

if (result.error) fail(2, `Could not run npm audit: ${result.error.message}`);

// npm audit exits non-zero when it finds something, which is the normal case
// here — the JSON on stdout is what matters. Only an unparseable body is fatal.
let report;
try {
  report = JSON.parse(result.stdout);
} catch {
  fail(2, `npm audit did not return JSON.\n${result.stdout}\n${result.stderr}`);
}

if (report.error) {
  fail(2, `npm audit reported an error: ${JSON.stringify(report.error)}`);
}

let allowlist;
try {
  allowlist = JSON.parse(readFileSync(ALLOWLIST, "utf8"));
} catch (error) {
  fail(2, `Could not read ${path.relative(ROOT, ALLOWLIST)}: ${error.message}`);
}

const allowed = new Map(
  (allowlist.advisories ?? []).map((entry) => [String(entry.id), entry]),
);

// One advisory can surface under several package entries; key by advisory id.
const found = new Map();
for (const vulnerability of Object.values(report.vulnerabilities ?? {})) {
  for (const via of vulnerability.via ?? []) {
    if (typeof via !== "object") continue;
    found.set(String(via.source), {
      id: String(via.source),
      package: via.name,
      title: via.title,
      severity: via.severity,
      range: via.range,
      url: via.url,
    });
  }
}

const today = new Date().toISOString().slice(0, 10);
const blocking = [];
const carried = [];

for (const advisory of found.values()) {
  if (!BLOCKING.has(advisory.severity)) continue;

  const entry = allowed.get(advisory.id);
  if (!entry) {
    blocking.push({ advisory, why: "not allow-listed" });
    continue;
  }
  if (!entry.expires || entry.expires < today) {
    blocking.push({
      advisory,
      why: `allowlist entry expired on ${entry.expires ?? "(no expiry set)"}`,
    });
    continue;
  }
  carried.push({ advisory, entry });
}

for (const { advisory, entry } of carried) {
  console.log(
    `carried  ${advisory.id}  ${advisory.severity.padEnd(8)} ${advisory.package} — ${entry.reason} (review by ${entry.expires})`,
  );
}

// An entry for something npm no longer reports is stale. Not fatal — it is
// usually a fix landing — but it should not sit there unnoticed.
for (const [id, entry] of allowed) {
  if (!found.has(id)) {
    console.log(`stale    ${id}  no longer reported (${entry.package}); remove it from the allowlist`);
  }
}

if (blocking.length > 0) {
  console.error("\nBlocking advisories in the runtime dependency tree:\n");
  for (const { advisory, why } of blocking) {
    console.error(`  ${advisory.id}  ${advisory.severity}  ${advisory.package} ${advisory.range}`);
    console.error(`    ${advisory.title}`);
    console.error(`    ${advisory.url}`);
    console.error(`    ${why}\n`);
  }
  console.error(
    "Upgrade the dependency, or add the advisory to .audit-allowlist.json with a reason and an expiry date and say why in the PR.",
  );
  process.exit(1);
}

console.log(`\nNo unreviewed high or critical advisories in the runtime tree (${carried.length} carried).`);
